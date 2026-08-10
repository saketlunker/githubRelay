import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..", "..");
const testOutput = path.join(repositoryRoot, ".test-output");
const supervisorSource = path.join(repositoryRoot, "runtime");
const fakeBackendSource = path.join(
  repositoryRoot,
  "tests",
  "fixtures",
  "fake-backend.mjs",
);

function randomPort() {
  return 20_000 + Math.floor(Math.random() * 20_000);
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createInstallation({ authenticated = true } = {}) {
  mkdirSync(testOutput, { recursive: true });
  const root = mkdtempSync(path.join(testOutput, "chg supervisor -"));
  const releaseId = "test-release";
  const release = path.join(root, "versions", releaseId);
  mkdirSync(release, { recursive: true });
  cpSync(supervisorSource, path.join(release, "runtime"), { recursive: true });
  cpSync(fakeBackendSource, path.join(release, "fake-backend.mjs"));

  let publicPort = randomPort();
  let backendPort = randomPort();
  while (backendPort === publicPort) {
    backendPort = randomPort();
  }
  const secrets = {
    schemaVersion: 1,
    clientApiKey: "client-key-abcdefghijklmnopqrstuvwxyz",
    internalApiKey: "internal-key-abcdefghijklmnopqrstuvwxyz",
    adminApiKey: "admin-key-abcdefghijklmnopqrstuvwxyz",
  };
  writeJson(path.join(root, "config", "gateway.json"), {
    schemaVersion: 1,
    listen: { address: "127.0.0.1", port: publicPort },
    backend: { address: "127.0.0.1", port: backendPort },
    limits: {
      maxConcurrentRequests: 1,
      requestsPerMinute: 60,
      burst: 10,
      requestTimeoutMs: 10_000,
    },
    supervision: {
      startupTimeoutMs: 10_000,
      initialRestartDelayMs: 100,
      maximumRestartDelayMs: 1_000,
      maximumRestarts: 3,
      restartWindowMs: 60_000,
      stableResetMs: 60_000,
    },
    logging: {
      maximumFileBytes: 65_536,
      retainedFiles: 2,
      captureBackendOutput: false,
    },
  });
  writeJson(path.join(root, "secrets", "secrets.json"), secrets);
  writeJson(path.join(root, "state", "install.json"), {
    schemaVersion: 1,
    activeVersionId: releaseId,
    previousVersionId: null,
    nodePath: process.execPath,
    nodeVersion: process.version.slice(1),
    releases: {
      [releaseId]: {
        backendVersion: "test",
        entrypoint: "fake-backend.mjs",
      },
    },
  });
  writeJson(path.join(root, "state", "desired-state.json"), {
    schemaVersion: 1,
    state: "running",
  });
  writeJson(path.join(root, "data", "backend", "config.json"), {
    auth: {
      apiKeys: [secrets.internalApiKey],
      adminApiKey: secrets.adminApiKey,
    },
  });
  if (authenticated) {
    writeFileSync(
      path.join(root, "data", "backend", "github_token"),
      "fake-github-token\n",
      "utf8",
    );
  }
  return { root, release, publicPort, backendPort, secrets };
}

async function waitFor(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError ?? new Error("Timed out");
}

function startSupervisor(installation) {
  const supervisor = path.join(
    installation.release,
    "runtime",
    "supervisor.mjs",
  );
  const child = spawn(process.execPath, [supervisor, "--root", installation.root], {
    cwd: installation.release,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  child.collectedOutput = () => output;
  return child;
}

async function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null) {
    return child.exitCode;
  }
  return await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Process did not exit")), timeoutMs),
    ),
  ]);
}

test("supervisor authenticates, limits, proxies, and blocks sensitive routes", async (t) => {
  const installation = createInstallation();
  writeJson(path.join(installation.root, "state", "runtime.lock"), {
    schemaVersion: 1,
    pid: 2_147_480_000,
    instanceId: "stale-instance",
    root: installation.root,
  });
  const child = startSupervisor(installation);
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await waitForExit(child).catch(() => {});
    }
    rmSync(installation.root, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${installation.publicPort}`;
  const health = await waitFor(async () => {
    const response = await fetch(`${base}/_gateway/health`);
    const body = await response.json();
    return body.status === "ready" ? body : null;
  });
  assert.equal(health.backendReady, true);
  if (process.platform === "win32") {
    const windowProbe = spawnSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${child.pid}).MainWindowHandle`,
      ],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(windowProbe.status, 0);
    assert.equal(windowProbe.stdout.trim(), "0");
  }

  const unauthenticated = await fetch(`${base}/v1/models`);
  assert.equal(unauthenticated.status, 401);
  const models = await fetch(`${base}/v1/models`, {
    headers: { "x-api-key": installation.secrets.clientApiKey },
  });
  assert.equal(models.status, 200);
  assert.equal((await models.json()).data.length, 2);

  const token = await fetch(`${base}/token`, {
    headers: { "x-api-key": installation.secrets.clientApiKey },
  });
  assert.equal(token.status, 404);
  assert.doesNotMatch(await token.text(), /UPSTREAM_TOKEN/);

  const origin = await fetch(`${base}/v1/models`, {
    headers: {
      "x-api-key": installation.secrets.clientApiKey,
      origin: "https://attacker.example",
    },
  });
  assert.equal(origin.status, 403);

  const first = fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": installation.secrets.clientApiKey,
      "x-test-delay": "500",
    },
    body: JSON.stringify({ prompt: "PROMPT_SHOULD_NOT_BE_LOGGED" }),
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const second = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": installation.secrets.clientApiKey,
    },
    body: "{}",
  });
  assert.equal(second.status, 429);
  assert.equal((await first).status, 200);

  const duplicate = startSupervisor(installation);
  assert.equal(await waitForExit(duplicate), 0, duplicate.collectedOutput());

  const shutdown = await fetch(`${base}/_gateway/shutdown`, {
    method: "POST",
    headers: { "x-gateway-admin": installation.secrets.adminApiKey },
  });
  assert.equal(shutdown.status, 202);
  assert.equal(await waitForExit(child), 0, child.collectedOutput());

  const log = readFileSync(
    path.join(installation.root, "logs", "supervisor.jsonl"),
    "utf8",
  );
  assert.doesNotMatch(log, /PROMPT_SHOULD_NOT_BE_LOGGED/);
  assert.doesNotMatch(log, new RegExp(installation.secrets.clientApiKey));
  assert.match(log, /backend\.ready/);
});

test("missing authentication is blocked without starting the backend", async (t) => {
  const installation = createInstallation({ authenticated: false });
  const child = startSupervisor(installation);
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await waitForExit(child).catch(() => {});
    }
    rmSync(installation.root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${installation.publicPort}`;
  const health = await waitFor(async () => {
    const response = await fetch(`${base}/_gateway/health`);
    const body = await response.json();
    return body.status === "blocked-auth" ? body : null;
  });
  assert.equal(health.backendReady, false);

  await fetch(`${base}/_gateway/shutdown`, {
    method: "POST",
    headers: { "x-gateway-admin": installation.secrets.adminApiKey },
  });
  assert.equal(await waitForExit(child), 0, child.collectedOutput());
});

test("an unrelated internal-port owner is reported and never killed", async (t) => {
  const installation = createInstallation();
  const unrelated = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("unrelated");
  });
  await new Promise((resolve) =>
    unrelated.listen(installation.backendPort, "127.0.0.1", resolve),
  );
  const child = startSupervisor(installation);
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await waitForExit(child).catch(() => {});
    }
    await new Promise((resolve) => unrelated.close(resolve));
    rmSync(installation.root, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${installation.publicPort}`;
  const health = await waitFor(async () => {
    const response = await fetch(`${base}/_gateway/health`);
    const body = await response.json();
    return body.status === "blocked-port" ? body : null;
  });
  assert.equal(health.backendReady, false);
  assert.equal(
    await (await fetch(`http://127.0.0.1:${installation.backendPort}`)).text(),
    "unrelated",
  );

  await fetch(`${base}/_gateway/shutdown`, {
    method: "POST",
    headers: { "x-gateway-admin": installation.secrets.adminApiKey },
  });
  assert.equal(await waitForExit(child), 0, child.collectedOutput());
});
