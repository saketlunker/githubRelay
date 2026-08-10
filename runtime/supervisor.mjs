import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  JsonlLogger,
  LOOPBACK_ADDRESS,
  TokenBucket,
  assertLoopbackAddress,
  boundedInteger,
  constantTimeEqual,
  isAllowedApiPath,
  isAllowedOrigin,
  requestApiKey,
  resolveInside,
  restartDelayMilliseconds,
  safePathname,
  validatePort,
} from "./lib/supervisor-core.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const DEFAULT_CONFIGURATION = Object.freeze({
  limits: {
    maxConcurrentRequests: 2,
    requestsPerMinute: 20,
    burst: 4,
    requestTimeoutMs: 900_000,
  },
  supervision: {
    startupTimeoutMs: 60_000,
    initialRestartDelayMs: 1_000,
    maximumRestartDelayMs: 60_000,
    maximumRestarts: 8,
    restartWindowMs: 900_000,
    stableResetMs: 600_000,
  },
  logging: {
    maximumFileBytes: 5 * 1024 * 1024,
    retainedFiles: 5,
    captureBackendOutput: false,
  },
  network: {
    proxyFromEnvironment: false,
  },
});

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") {
      result.root = argv[++index];
      continue;
    }
    throw new Error(`Unknown supervisor argument: ${argument}`);
  }
  if (!result.root) {
    throw new Error("--root is required");
  }
  return result;
}

function readJson(file, description) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`Unable to read ${description}: ${file}`, {
      cause: error,
    });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in ${description}: ${file}`, {
      cause: error,
    });
  }
}

function writeAtomicJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try {
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

function mergeConfiguration(configuration) {
  const listen = configuration.listen ?? {};
  const backend = configuration.backend ?? {};
  const limits = { ...DEFAULT_CONFIGURATION.limits, ...configuration.limits };
  const supervision = {
    ...DEFAULT_CONFIGURATION.supervision,
    ...configuration.supervision,
  };
  const logging = {
    ...DEFAULT_CONFIGURATION.logging,
    ...configuration.logging,
  };
  const network = {
    ...DEFAULT_CONFIGURATION.network,
    ...configuration.network,
  };

  const listenAddress = assertLoopbackAddress(listen.address);
  const backendAddress = assertLoopbackAddress(backend.address);
  const listenPort = validatePort(listen.port, "listen.port");
  const backendPort = validatePort(backend.port, "backend.port");
  if (listenPort === backendPort) {
    throw new Error("listen.port and backend.port must differ");
  }

  return {
    schemaVersion: configuration.schemaVersion,
    listen: { address: listenAddress, port: listenPort },
    backend: { address: backendAddress, port: backendPort },
    limits: {
      maxConcurrentRequests: boundedInteger(
        limits.maxConcurrentRequests,
        "limits.maxConcurrentRequests",
        1,
        16,
      ),
      requestsPerMinute: boundedInteger(
        limits.requestsPerMinute,
        "limits.requestsPerMinute",
        1,
        600,
      ),
      burst: boundedInteger(limits.burst, "limits.burst", 1, 100),
      requestTimeoutMs: boundedInteger(
        limits.requestTimeoutMs,
        "limits.requestTimeoutMs",
        5_000,
        3_600_000,
      ),
    },
    supervision: {
      startupTimeoutMs: boundedInteger(
        supervision.startupTimeoutMs,
        "supervision.startupTimeoutMs",
        5_000,
        300_000,
      ),
      initialRestartDelayMs: boundedInteger(
        supervision.initialRestartDelayMs,
        "supervision.initialRestartDelayMs",
        100,
        60_000,
      ),
      maximumRestartDelayMs: boundedInteger(
        supervision.maximumRestartDelayMs,
        "supervision.maximumRestartDelayMs",
        1_000,
        600_000,
      ),
      maximumRestarts: boundedInteger(
        supervision.maximumRestarts,
        "supervision.maximumRestarts",
        1,
        100,
      ),
      restartWindowMs: boundedInteger(
        supervision.restartWindowMs,
        "supervision.restartWindowMs",
        60_000,
        86_400_000,
      ),
      stableResetMs: boundedInteger(
        supervision.stableResetMs,
        "supervision.stableResetMs",
        60_000,
        86_400_000,
      ),
    },
    logging: {
      maximumFileBytes: boundedInteger(
        logging.maximumFileBytes,
        "logging.maximumFileBytes",
        64 * 1024,
        100 * 1024 * 1024,
      ),
      retainedFiles: boundedInteger(
        logging.retainedFiles,
        "logging.retainedFiles",
        1,
        20,
      ),
      captureBackendOutput: logging.captureBackendOutput === true,
    },
    network: {
      proxyFromEnvironment: network.proxyFromEnvironment === true,
    },
  };
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function windowsProcessCommandLine(pid) {
  if (!isProcessAlive(pid)) {
    return "";
  }
  if (process.platform !== "win32") {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
    } catch {
      return "";
    }
  }
  const command = [
    "$ErrorActionPreference='Stop'",
    `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
    "if ($process) { [Console]::Out.Write($process.CommandLine) }",
  ].join("; ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
    { encoding: "utf8", windowsHide: true, timeout: 10_000 },
  );
  return result.status === 0 ? result.stdout : "";
}

async function cleanupStaleBackend({
  runtimeFile,
  entrypoint,
  port,
  logger,
}) {
  if (!(await portIsListening(port))) {
    return;
  }
  let runtime;
  try {
    runtime = readJson(runtimeFile, "previous runtime state");
  } catch {
    runtime = {};
  }
  const pid = Number(runtime.backendPid);
  const commandLine = windowsProcessCommandLine(pid).toLowerCase();
  if (
    !isProcessAlive(pid) ||
    !commandLine.includes(path.resolve(entrypoint).toLowerCase())
  ) {
    throw new Error(
      `Backend port ${port} is occupied by a process not owned by this installation`,
    );
  }
  logger.write("warn", "backend.stale_process", { pid });
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // The process may exit between identity verification and termination.
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && (await portIsListening(port))) {
    await sleep(100);
  }
  if (await portIsListening(port)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The final port check below determines whether cleanup succeeded.
    }
    await sleep(250);
  }
  if (await portIsListening(port)) {
    throw new Error(`Unable to clean stale backend process ${pid}`);
  }
}

async function requestJson({ port, pathname, headers = {}, timeoutMs = 2_000 }) {
  return await new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: LOOPBACK_ADDRESS,
        port,
        path: pathname,
        method: "GET",
        headers,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            body = text;
          }
          resolve({ statusCode: response.statusCode ?? 0, body });
        });
      },
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("Health probe timed out"));
    });
    request.once("error", reject);
    request.end();
  });
}

async function acquireRuntimeLock(lockFile, expectedRoot, listenPort) {
  const instanceId = randomBytes(16).toString("hex");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(lockFile, "wx", 0o600);
      writeFileSync(
        descriptor,
        `${JSON.stringify({
          schemaVersion: 1,
          pid: process.pid,
          instanceId,
          root: expectedRoot,
          startedAt: new Date().toISOString(),
        })}\n`,
        "utf8",
      );
      closeSync(descriptor);
      return instanceId;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      let existing;
      try {
        existing = readJson(lockFile, "runtime lock");
      } catch {
        existing = {};
      }
      if (isProcessAlive(existing.pid)) {
        try {
          const health = await requestJson({
            port: listenPort,
            pathname: "/_gateway/health",
          });
          if (
            health.statusCode === 200 &&
            health.body?.instanceId === existing.instanceId
          ) {
            return null;
          }
        } catch {
          // Fall through to process identity verification.
        }
        const commandLine = windowsProcessCommandLine(existing.pid);
        if (
          commandLine.toLowerCase().includes("supervisor.mjs") &&
          commandLine.toLowerCase().includes(expectedRoot.toLowerCase())
        ) {
          throw new Error(
            `Supervisor lock is held by live process ${existing.pid}`,
          );
        }
      }
      rmSync(lockFile, { force: true });
    }
  }
  throw new Error("Unable to acquire the supervisor lock");
}

function releaseRuntimeLock(lockFile, instanceId) {
  try {
    const existing = readJson(lockFile, "runtime lock");
    if (
      existing.pid === process.pid &&
      constantTimeEqual(existing.instanceId, instanceId)
    ) {
      rmSync(lockFile, { force: true });
    }
  } catch {
    // Never remove a lock whose ownership cannot be confirmed.
  }
}

function hasBackendCredential(backendHome) {
  const githubToken = path.join(backendHome, "github_token");
  if (existsSync(githubToken)) {
    try {
      if (readFileSync(githubToken, "utf8").trim().length > 0) {
        return true;
      }
    } catch {
      return false;
    }
  }
  const upstreamConfig = path.join(backendHome, "config.json");
  if (!existsSync(upstreamConfig)) {
    return false;
  }
  try {
    const config = readJson(upstreamConfig, "upstream configuration");
    return Object.values(config.providers ?? {}).some(
      (provider) => provider?.enabled === true,
    );
  } catch {
    return false;
  }
}

function portIsListening(port, host = LOOPBACK_ADDRESS, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let completed = false;
    const done = (value) => {
      if (completed) {
        return;
      }
      completed = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function assertBackendIsLoopbackOnly(port) {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) {
        continue;
      }
      if (await portIsListening(port, address.address, 300)) {
        throw new Error(
          `Backend port ${port} is reachable through non-loopback address ${address.address}`,
        );
      }
    }
  }
}

async function waitForBackendReady({
  port,
  internalApiKey,
  child,
  timeoutMs,
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.spawnError) {
      throw new Error(`Backend could not be spawned: ${child.spawnError.message}`);
    }
    if (child.exitCode !== null) {
      throw new Error(`Backend exited during startup with ${child.exitCode}`);
    }
    try {
      const root = await requestJson({ port, pathname: "/" });
      if (root.statusCode === 200) {
        const models = await requestJson({
          port,
          pathname: "/v1/models",
          headers: { "x-api-key": internalApiKey },
          timeoutMs: 5_000,
        });
        if (
          models.statusCode === 200 &&
          Array.isArray(models.body?.data)
        ) {
          await assertBackendIsLoopbackOnly(port);
          return;
        }
      }
    } catch {
      // Startup probes are bounded by the outer deadline.
    }
    await sleep(500);
  }
  throw new Error(`Backend did not become ready within ${timeoutMs}ms`);
}

function sanitizeForwardHeaders(headers, internalApiKey) {
  const forwarded = { ...headers };
  for (const name of [
    "host",
    "authorization",
    "x-api-key",
    "x-gateway-admin",
    "connection",
    "proxy-connection",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
  ]) {
    delete forwarded[name];
  }
  forwarded["x-api-key"] = internalApiKey;
  return forwarded;
}

function sanitizeResponseHeaders(headers) {
  const forwarded = { ...headers };
  for (const name of [
    "connection",
    "proxy-connection",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
    "access-control-allow-origin",
    "access-control-allow-credentials",
    "access-control-allow-headers",
    "access-control-allow-methods",
  ]) {
    delete forwarded[name];
  }
  return forwarded;
}

function sendJson(response, statusCode, value, headers = {}) {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(`${JSON.stringify(value)}\n`);
}

async function main() {
  const { root: rootArgument } = parseArguments(process.argv.slice(2));
  const root = path.resolve(rootArgument);
  const paths = {
    config: path.join(root, "config", "gateway.json"),
    secrets: path.join(root, "secrets", "secrets.json"),
    install: path.join(root, "state", "install.json"),
    desired: path.join(root, "state", "desired-state.json"),
    runtime: path.join(root, "state", "runtime.json"),
    lock: path.join(root, "state", "runtime.lock"),
    backendHome: path.join(root, "data", "backend"),
    logs: path.join(root, "logs"),
    supervisorLog: path.join(root, "logs", "supervisor.jsonl"),
    upstreamLogs: path.join(root, "logs", "upstream"),
  };
  mkdirSync(path.join(root, "state"), { recursive: true });
  mkdirSync(paths.logs, { recursive: true });
  mkdirSync(paths.upstreamLogs, { recursive: true });
  mkdirSync(paths.backendHome, { recursive: true });

  const configuration = mergeConfiguration(
    readJson(paths.config, "gateway configuration"),
  );
  if (configuration.schemaVersion !== 1) {
    throw new Error(
      `Unsupported gateway schema version: ${configuration.schemaVersion}`,
    );
  }
  const secrets = readJson(paths.secrets, "gateway secrets");
  for (const name of ["clientApiKey", "internalApiKey", "adminApiKey"]) {
    if (typeof secrets[name] !== "string" || secrets[name].length < 32) {
      throw new Error(`Missing or invalid ${name}`);
    }
  }
  const install = readJson(paths.install, "install state");
  const release = install.releases?.[install.activeVersionId];
  if (!release) {
    throw new Error("Active immutable release is missing from install state");
  }
  const releasePath = path.resolve(root, "versions", install.activeVersionId);
  const entrypoint = resolveInside(releasePath, release.entrypoint);
  if (!existsSync(entrypoint)) {
    throw new Error(`Backend entrypoint is missing: ${entrypoint}`);
  }
  const nodePath = path.resolve(install.nodePath);
  if (!existsSync(nodePath)) {
    throw new Error(`Pinned Node executable is missing: ${nodePath}`);
  }

  const logger = new JsonlLogger({
    file: paths.supervisorLog,
    maximumFileBytes: configuration.logging.maximumFileBytes,
    retainedFiles: configuration.logging.retainedFiles,
    knownSecrets: Object.values(secrets),
  });

  const instanceId = await acquireRuntimeLock(
    paths.lock,
    root,
    configuration.listen.port,
  );
  if (instanceId === null) {
    return;
  }
  process.once("exit", () => releaseRuntimeLock(paths.lock, instanceId));

  let shuttingDown = false;
  let backendReady = false;
  let backendChild = null;
  let backendStartedAt = 0;
  let backendOutputBytes = 0;
  let activeRequests = 0;
  let status = "starting";
  let lastError = null;
  let finishPromise = null;
  const restartTimestamps = [];
  const rateLimiter = new TokenBucket(configuration.limits);
  const backendCredentialPresent = hasBackendCredential(paths.backendHome);

  const persistRuntime = (extra = {}) => {
    writeAtomicJson(paths.runtime, {
      schemaVersion: 1,
      instanceId,
      supervisorPid: process.pid,
      backendPid: backendChild?.pid ?? null,
      activeVersionId: install.activeVersionId,
      status,
      backendReady,
      activeRequests,
      lastError,
      updatedAt: new Date().toISOString(),
      ...extra,
    });
  };

  const terminateBackend = async () => {
    const child = backendChild;
    if (!child || child.exitCode !== null || child.spawnError) {
      backendChild = null;
      backendReady = false;
      return;
    }
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      sleep(5_000),
    ]);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
    backendChild = null;
    backendReady = false;
  };

  const proxyServer = http.createServer((request, response) => {
    const startedAt = Date.now();
    const pathname = safePathname(request.url ?? "/");
    if (pathname === "/_gateway/health" && request.method === "GET") {
      sendJson(response, status === "ready" ? 200 : 503, {
        status,
        backendReady,
        instanceId,
        activeVersionId: install.activeVersionId,
      });
      return;
    }
    if (pathname === "/_gateway/shutdown" && request.method === "POST") {
      const supplied =
        typeof request.headers["x-gateway-admin"] === "string"
          ? request.headers["x-gateway-admin"]
          : "";
      if (!constantTimeEqual(supplied, secrets.adminApiKey)) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      sendJson(response, 202, { status: "stopping" });
      void finish();
      return;
    }
    if (!isAllowedOrigin(request.headers.origin)) {
      sendJson(response, 403, { error: "origin_not_allowed" });
      return;
    }
    if (!isAllowedApiPath(request.url ?? "/")) {
      sendJson(response, 404, { error: "route_not_exposed" });
      return;
    }
    const suppliedKey = requestApiKey(request.headers);
    if (!constantTimeEqual(suppliedKey, secrets.clientApiKey)) {
      sendJson(response, 401, { error: "unauthorized" }, {
        "www-authenticate": 'Bearer realm="copilot-harness-gateway"',
      });
      return;
    }
    if (!backendReady) {
      sendJson(response, 503, { error: "backend_not_ready" });
      return;
    }
    const rate = rateLimiter.take();
    if (!rate.allowed) {
      sendJson(response, 429, { error: "rate_limited" }, {
        "retry-after": String(rate.retryAfterSeconds),
      });
      return;
    }
    if (activeRequests >= configuration.limits.maxConcurrentRequests) {
      sendJson(response, 429, { error: "concurrency_limited" }, {
        "retry-after": "1",
      });
      return;
    }

    activeRequests += 1;
    persistRuntime();
    let released = false;
    const releaseRequest = (statusCode = 0) => {
      if (released) {
        return;
      }
      released = true;
      activeRequests = Math.max(0, activeRequests - 1);
      persistRuntime();
      logger.write("info", "request.completed", {
        method: request.method ?? "UNKNOWN",
        path: pathname,
        statusCode,
        durationMs: Date.now() - startedAt,
      });
    };

    const upstreamRequest = http.request(
      {
        host: configuration.backend.address,
        port: configuration.backend.port,
        path: request.url,
        method: request.method,
        headers: sanitizeForwardHeaders(
          request.headers,
          secrets.internalApiKey,
        ),
      },
      (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          sanitizeResponseHeaders(upstreamResponse.headers),
        );
        upstreamResponse.pipe(response);
        upstreamResponse.once("end", () =>
          releaseRequest(upstreamResponse.statusCode ?? 0),
        );
        upstreamResponse.once("error", () =>
          releaseRequest(upstreamResponse.statusCode ?? 0),
        );
        response.once("close", () =>
          releaseRequest(upstreamResponse.statusCode ?? 0),
        );
      },
    );
    upstreamRequest.setTimeout(configuration.limits.requestTimeoutMs, () => {
      upstreamRequest.destroy(new Error("Upstream request timed out"));
    });
    upstreamRequest.once("error", (error) => {
      if (!response.headersSent) {
        sendJson(response, 502, { error: "upstream_error" });
      } else {
        response.destroy(error);
      }
      releaseRequest(502);
    });
    request.once("aborted", () => {
      upstreamRequest.destroy();
      releaseRequest(499);
    });
    request.pipe(upstreamRequest);
  });

  const finish = () => {
    if (finishPromise) {
      return finishPromise;
    }
    finishPromise = (async () => {
      shuttingDown = true;
      status = "stopping";
      persistRuntime();
      await terminateBackend();
      await new Promise((resolve) => proxyServer.close(() => resolve()));
      status = "stopped";
      persistRuntime();
      releaseRuntimeLock(paths.lock, instanceId);
      logger.write("info", "supervisor.stopped");
    })();
    return finishPromise;
  };

  process.once("SIGINT", () => void finish());
  process.once("SIGTERM", () => void finish());
  process.once("beforeExit", () => releaseRuntimeLock(paths.lock, instanceId));
  process.once("uncaughtException", (error) => {
    logger.write("error", "supervisor.uncaught", {
      message: error.message,
    });
    void finish().finally(() => process.exit(1));
  });
  process.once("unhandledRejection", (error) => {
    logger.write("error", "supervisor.unhandled_rejection", {
      message: error instanceof Error ? error.message : String(error),
    });
    void finish().finally(() => process.exit(1));
  });

  await new Promise((resolve, reject) => {
    proxyServer.once("error", reject);
    proxyServer.listen(
      configuration.listen.port,
      configuration.listen.address,
      resolve,
    );
  });
  logger.write("info", "supervisor.started", {
    pid: process.pid,
    activeVersionId: install.activeVersionId,
    listenAddress: configuration.listen.address,
    listenPort: configuration.listen.port,
  });

  if (!backendCredentialPresent) {
    status = "blocked-auth";
    lastError =
      "GitHub authentication is missing; run gateway.ps1 authenticate";
    persistRuntime();
    logger.write("warn", "backend.blocked_auth");
  } else {
    try {
      await cleanupStaleBackend({
        runtimeFile: paths.runtime,
        entrypoint,
        port: configuration.backend.port,
        logger,
      });
    } catch (error) {
      status = "blocked-port";
      lastError = error.message;
      persistRuntime();
      logger.write("error", "backend.blocked_port", {
        message: error.message,
      });
    }
    while (!shuttingDown && status !== "blocked-port") {
      const desired = existsSync(paths.desired)
        ? readJson(paths.desired, "desired state").state
        : "running";
      if (desired !== "running") {
        status = "stopped";
        persistRuntime();
        break;
      }

      const now = Date.now();
      while (
        restartTimestamps.length > 0 &&
        now - restartTimestamps[0] >
          configuration.supervision.restartWindowMs
      ) {
        restartTimestamps.shift();
      }
      if (
        restartTimestamps.length >=
        configuration.supervision.maximumRestarts
      ) {
        status = "blocked-restart-limit";
        lastError = "Backend restart limit reached";
        persistRuntime();
        logger.write("error", "backend.restart_limit");
        break;
      }

      status = "starting";
      backendReady = false;
      lastError = null;
      backendOutputBytes = 0;
      persistRuntime();
      backendStartedAt = Date.now();
      const backendArguments = [
        entrypoint,
        "start",
        "--port",
        String(configuration.backend.port),
      ];
      if (configuration.network.proxyFromEnvironment) {
        backendArguments.push("--proxy-env");
      }
      const proxyEnvironment = {};
      if (configuration.network.proxyFromEnvironment) {
        for (const name of [
          "HTTP_PROXY",
          "HTTPS_PROXY",
          "ALL_PROXY",
          "http_proxy",
          "https_proxy",
          "all_proxy",
        ]) {
          if (process.env[name]) {
            proxyEnvironment[name] = process.env[name];
          }
        }
      }
      backendChild = spawn(
        nodePath,
        backendArguments,
        {
          cwd: releasePath,
          shell: false,
          detached: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            SystemRoot: process.env.SystemRoot,
            WINDIR: process.env.WINDIR,
            COMSPEC: process.env.COMSPEC,
            PATH: process.env.PATH,
            TEMP: process.env.TEMP,
            TMP: process.env.TMP,
            USERPROFILE: process.env.USERPROFILE,
            LOCALAPPDATA: process.env.LOCALAPPDATA,
            APPDATA: process.env.APPDATA,
            NODE_ENV: "production",
            NODE_NO_WARNINGS: "1",
            NODE_USE_SYSTEM_CA: "1",
            HOST: configuration.backend.address,
            COPILOT_API_HOME: paths.backendHome,
            COPILOT_API_LOG_DIR: paths.upstreamLogs,
            COPILOT_API_SQLITE_DB_PATH: path.join(
              paths.backendHome,
              "copilot-api.sqlite",
            ),
            NO_PROXY: "127.0.0.1,localhost",
            no_proxy: "127.0.0.1,localhost",
            ...proxyEnvironment,
          },
        },
      );
      const spawnedChild = backendChild;
      spawnedChild.spawnError = null;
      spawnedChild.once("error", (error) => {
        spawnedChild.spawnError = error;
      });
      for (const [streamName, stream] of [
        ["stdout", backendChild.stdout],
        ["stderr", backendChild.stderr],
      ]) {
        stream.on("data", (chunk) => {
          backendOutputBytes += chunk.length;
          if (configuration.logging.captureBackendOutput) {
            logger.write("debug", "backend.output", {
              stream: streamName,
              message: chunk.toString("utf8"),
            });
          }
        });
      }
      logger.write("info", "backend.spawned", {
        pid: backendChild.pid,
        backendVersion: release.backendVersion,
      });
      persistRuntime();

      try {
        await waitForBackendReady({
          port: configuration.backend.port,
          internalApiKey: secrets.internalApiKey,
          child: backendChild,
          timeoutMs: configuration.supervision.startupTimeoutMs,
        });
        backendReady = true;
        status = "ready";
        persistRuntime();
        logger.write("info", "backend.ready", {
          pid: backendChild.pid,
          backendVersion: release.backendVersion,
        });
      } catch (error) {
        lastError = error.message;
        status = "backend-failed";
        persistRuntime();
        logger.write("error", "backend.start_failed", {
          message: error.message,
        });
        await terminateBackend();
      }

      if (backendChild) {
        const child = backendChild;
        if (child.exitCode === null) {
          await new Promise((resolve) => child.once("exit", resolve));
        }
        backendChild = null;
        backendReady = false;
      }
      if (shuttingDown) {
        break;
      }

      const lifetime = Date.now() - backendStartedAt;
      if (lifetime >= configuration.supervision.stableResetMs) {
        restartTimestamps.length = 0;
      }
      restartTimestamps.push(Date.now());
      const delay = restartDelayMilliseconds(
        restartTimestamps.length - 1,
        configuration.supervision.initialRestartDelayMs,
        configuration.supervision.maximumRestartDelayMs,
      );
      status = "backoff";
      persistRuntime({
        restartAfter: new Date(Date.now() + delay).toISOString(),
      });
      logger.write("warn", "backend.exited", {
        delayMs: delay,
        capturedOutputBytes: backendOutputBytes,
      });
      await sleep(delay);
    }
  }

  if (!shuttingDown) {
    await new Promise((resolve) => proxyServer.once("close", resolve));
  }
  await finish();
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath);
if (invokedDirectly) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`copilot-harness-gateway supervisor: ${message}\n`);
    process.exitCode = 1;
  });
}

export {
  DEFAULT_CONFIGURATION,
  acquireRuntimeLock,
  assertBackendIsLoopbackOnly,
  hasBackendCredential,
  mergeConfiguration,
  parseArguments,
  writeAtomicJson,
};
