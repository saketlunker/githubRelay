import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { initializeDesktopState } from "../../../../runtime/lib/desktop-state.mjs";
import {
  buildProbeRequest,
  modelCapabilitySummary,
} from "../../../../runtime/lib/model-capabilities.mjs";
import {
  loadModelCatalog,
  readModelCache,
} from "../../../../runtime/lib/model-catalog.mjs";
import {
  atomicWriteJson,
  readJsonFile,
} from "../../../../runtime/lib/atomic-files.mjs";
import { runConfigureClients } from "../../../../runtime/configure-clients.mjs";

import type {
  ClientName,
  ClientView,
  ConfigureClientsInput,
  DesktopSettings,
  GatewayStatus,
  ModelProbeInput,
  ModelView,
} from "../shared/contracts";

interface ControllerOptions {
  root: string;
  releaseRoot: string;
  nodePath: string;
  appVersion: string;
  backendVersion: string;
  credentialVault?: {
    hasCredential(): Promise<boolean>;
    materialize(): Promise<void>;
    seal(): Promise<void>;
  };
}

interface DesktopContext {
  paths: {
    root: string;
    config: string;
    secrets: string;
    install: string;
    desired: string;
    settings: string;
    backendConfig: string;
    supervisor: string;
  };
  secrets: {
    clientApiKey: string;
    internalApiKey: string;
    adminApiKey: string;
  };
  install: {
    activeVersionId: string;
  };
  settings: DesktopSettings;
}

const CLIENT_EXECUTABLES: Record<ClientName, string> = {
  claude: "claude",
  codex: "codex",
  opencode: "opencode",
  pi: "pi",
};

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function nodeEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    NODE_ENV: "production",
    NODE_NO_WARNINGS: "1",
    NODE_USE_SYSTEM_CA: "1",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    ...extra,
  };
}

function redact(text: string) {
  return text
    .replaceAll(/github_pat_[A-Za-z0-9_]+/g, "[REDACTED]")
    .replaceAll(/gh[opusr]_[A-Za-z0-9]+/g, "[REDACTED]")
    .replaceAll(/(bearer\s+)[A-Za-z0-9._~+/-]+/gi, "$1[REDACTED]");
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit = {},
  timeoutMilliseconds = 5_000,
) {
  return await fetch(input, {
    ...init,
    signal: AbortSignal.timeout(timeoutMilliseconds),
  });
}

export class GatewayController extends EventEmitter {
  readonly options: ControllerOptions;
  private context: DesktopContext | null = null;
  private supervisor: ChildProcess | null = null;
  private authentication: ChildProcess | null = null;

  constructor(options: ControllerOptions) {
    super();
    this.options = {
      ...options,
      root: path.resolve(options.root),
      releaseRoot: path.resolve(options.releaseRoot),
      nodePath: path.resolve(options.nodePath),
    };
  }

  async initialize() {
    this.context = await initializeDesktopState(this.options) as DesktopContext;
    process.env.COPILOT_HARNESS_GATEWAY_API_KEY =
      this.context.secrets.clientApiKey;
    if ((await this.desiredState()) === "running") {
      try {
        await this.start();
      } catch (error) {
        this.emit(
          "diagnostic",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  private requiredContext() {
    if (this.context === null) {
      throw new Error("Gateway controller is not initialized.");
    }
    return this.context;
  }

  private endpoint() {
    return "http://127.0.0.1:4141";
  }

  private async desiredState(): Promise<"running" | "stopped"> {
    const desired = await readJsonFile(
      this.requiredContext().paths.desired,
      { required: true, label: "desired gateway state" },
    );
    return desired.state === "running" ? "running" : "stopped";
  }

  private async writeDesiredState(state: "running" | "stopped") {
    await atomicWriteJson(this.requiredContext().paths.desired, {
      schemaVersion: 1,
      state,
      updatedAt: new Date().toISOString(),
    });
  }

  private async health() {
    try {
      const response = await fetchWithTimeout(
        `${this.endpoint()}/_gateway/health`,
        {},
        1_500,
      );
      return {
        reachable: true,
        statusCode: response.status,
        body: await response.json() as Record<string, unknown>,
      };
    } catch {
      return { reachable: false, statusCode: 0, body: {} };
    }
  }

  async status(): Promise<GatewayStatus> {
    const context = this.requiredContext();
    const [desiredState, health, runtime, token, vaultedCredential] = await Promise.all([
      this.desiredState(),
      this.health(),
      readJsonFile(path.join(context.paths.root, "state", "runtime.json")),
      readFile(
        path.join(context.paths.root, "data", "backend", "github_token"),
        "utf8",
      ).catch(() => ""),
      this.options.credentialVault?.hasCredential() ?? Promise.resolve(false),
    ]);
    const healthStatus = typeof health.body.status === "string"
      ? health.body.status
      : null;
    return {
      desiredState,
      status: healthStatus
        ?? (typeof runtime?.status === "string" ? runtime.status : "stopped"),
      endpoint: this.endpoint(),
      authenticated: token.trim().length > 0 || vaultedCredential,
      supervisorPid: Number.isSafeInteger(runtime?.supervisorPid)
        ? runtime.supervisorPid
        : null,
      backendPid: Number.isSafeInteger(runtime?.backendPid)
        ? runtime.backendPid
        : null,
      activeVersionId: context.install.activeVersionId,
      lastError: typeof runtime?.lastError === "string" ? runtime.lastError : null,
    };
  }

  private spawnSupervisor() {
    if (this.supervisor?.exitCode === null) {
      return;
    }
    const context = this.requiredContext();
    this.supervisor = spawn(
      this.options.nodePath,
      [
        context.paths.supervisor,
        "--root",
        context.paths.root,
        "--release-root",
        this.options.releaseRoot,
      ],
      {
        cwd: this.options.releaseRoot,
        env: nodeEnvironment(),
        shell: false,
        detached: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.supervisor.stdout?.resume();
    this.supervisor.stderr?.on("data", (chunk: Buffer) => {
      this.emit("diagnostic", redact(chunk.toString("utf8")));
    });
    this.supervisor.once("exit", () => {
      this.supervisor = null;
      this.emit("changed");
    });
  }

  async start() {
    await this.options.credentialVault?.materialize();
    await this.writeDesiredState("running");
    const current = await this.health();
    if (current.body.status === "ready") {
      return;
    }
    this.spawnSupervisor();
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const status = await this.status();
      if (status.status === "ready") {
        this.emit("changed");
        return;
      }
      if (status.status.startsWith("blocked-")) {
        throw new Error(status.lastError ?? `Gateway is ${status.status}.`);
      }
      await delay(400);
    }
    throw new Error("Gateway did not become ready within 90 seconds.");
  }

  async stop(preserveDesiredState = false) {
    const context = this.requiredContext();
    if (!preserveDesiredState) {
      await this.writeDesiredState("stopped");
    }
    try {
      await fetchWithTimeout(
        `${this.endpoint()}/_gateway/shutdown`,
        {
          method: "POST",
          headers: { "x-gateway-admin": context.secrets.adminApiKey },
        },
        5_000,
      );
    } catch {
      if (this.supervisor?.exitCode === null) {
        this.supervisor.kill("SIGTERM");
      }
    }
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && (await this.health()).reachable) {
      await delay(200);
    }
    if ((await this.health()).reachable) {
      throw new Error("Gateway did not stop within 15 seconds.");
    }
    await this.options.credentialVault?.seal();
    this.emit("changed");
  }

  async restart() {
    await this.stop();
    await this.start();
  }

  async models(forceRefresh = false): Promise<{
    models: ModelView[];
    aliases: Record<string, string>;
  }> {
    const context = this.requiredContext();
    let catalog = await readModelCache(context.paths.root);
    if (forceRefresh || catalog === null) {
      catalog = (await loadModelCatalog({
        root: context.paths.root,
        forceRefresh: true,
      })).catalog;
    }
    return {
      models: catalog.models.map((model: Record<string, unknown>) =>
        modelCapabilitySummary(model) as ModelView),
      aliases: { ...catalog.aliases },
    };
  }

  async probeModel(input: ModelProbeInput) {
    const context = this.requiredContext();
    const catalog = (await loadModelCatalog({
      root: context.paths.root,
      forceRefresh: false,
    })).catalog;
    const model = catalog.models.find(
      (candidate: { id: string }) => candidate.id === input.modelId,
    );
    if (!model) {
      throw new Error(`Unknown model: ${input.modelId}`);
    }
    const request = buildProbeRequest({
      model,
      endpoint: input.endpoint,
      ...(input.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: input.reasoningEffort }),
    });
    const started = Date.now();
    const response = await fetchWithTimeout(
      `${this.endpoint()}${request.path}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": context.secrets.clientApiKey,
          ...(request.headers ?? {}),
        },
        body: JSON.stringify(request.body),
      },
      180_000,
    );
    const body = await response.json() as Record<string, unknown>;
    return {
      ok: response.ok,
      statusCode: response.status,
      latencyMs: Date.now() - started,
      requestedModel: input.modelId,
      returnedModel: typeof body.model === "string" ? body.model : null,
      requestedReasoning: input.reasoningEffort ?? null,
      returnedReasoning:
        typeof (body.reasoning as Record<string, unknown> | undefined)?.effort ===
          "string"
          ? (body.reasoning as Record<string, unknown>).effort
          : null,
      testedAt: new Date().toISOString(),
    };
  }

  private executable(name: string): string | null {
    const command = process.platform === "win32" ? "where.exe" : "which";
    const result = spawnSync(command, [name], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000,
    });
    return result.status === 0
      ? result.stdout.split(/\r?\n/u).find((line) => line.trim().length > 0)
          ?.trim() ?? null
      : null;
  }

  clients(): ClientView[] {
    return (Object.keys(CLIENT_EXECUTABLES) as ClientName[]).map((name) => {
      const executable = this.executable(CLIENT_EXECUTABLES[name]);
      return { name, installed: executable !== null, executable };
    });
  }

  async configureClients(input: ConfigureClientsInput) {
    const context = this.requiredContext();
    const output = await runConfigureClients({
      root: context.paths.root,
      clients: [...input.clients],
      home: undefined,
      model: input.model,
      claudeModel: input.claudeModel,
      codexModel: input.codexModel,
      fastModel: input.fastModel,
      setDefault: input.setDefault,
      dryRun: input.dryRun,
      remove: input.remove,
      force: false,
      modelsFile: undefined,
      timeoutMs: 30_000,
    }, {
      stdout: () => undefined,
    });
    if (!input.dryRun && !input.remove) {
      await this.persistClientKey();
    }
    return output as Record<string, unknown>;
  }

  private async persistClientKey() {
    const key = this.requiredContext().secrets.clientApiKey;
    process.env.COPILOT_HARNESS_GATEWAY_API_KEY = key;
    if (process.platform === "win32") {
      const script = [
        "[Environment]::SetEnvironmentVariable(",
        "'COPILOT_HARNESS_GATEWAY_API_KEY',",
        "$env:COPILOT_HARNESS_GATEWAY_API_KEY,",
        "'User')",
      ].join("");
      const result = spawnSync(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        { env: { ...process.env }, encoding: "utf8", windowsHide: true },
      );
      if (result.status !== 0) {
        throw new Error("Unable to persist the local client API key.");
      }
      return;
    }
    if (process.platform === "linux") {
      const environmentDirectory = path.join(
        process.env.XDG_CONFIG_HOME
          ?? path.join(process.env.HOME ?? "", ".config"),
        "environment.d",
      );
      await mkdir(environmentDirectory, { recursive: true, mode: 0o700 });
      await writeFile(
        path.join(environmentDirectory, "50-github-model-relay.conf"),
        `COPILOT_HARNESS_GATEWAY_API_KEY=${key}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      return;
    }
    if (process.platform === "darwin") {
      const result = spawnSync(
        "/bin/launchctl",
        ["setenv", "COPILOT_HARNESS_GATEWAY_API_KEY", key],
        { encoding: "utf8", windowsHide: true, timeout: 5_000 },
      );
      if (result.status !== 0) {
        throw new Error("Unable to publish the local client key to launchd.");
      }
    }
  }

  settings() {
    return { ...this.requiredContext().settings };
  }

  async updateSettings(settings: DesktopSettings) {
    await atomicWriteJson(this.requiredContext().paths.settings, {
      ...settings,
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
    });
    this.requiredContext().settings = { ...settings };
  }

  startAuthentication() {
    if (this.authentication?.exitCode === null) {
      throw new Error("Authentication is already running.");
    }
    const context = this.requiredContext();
    const operationId = randomUUID();
    void (async () => {
      const wasRunning = (await this.desiredState()) === "running";
      await this.stop();
      this.emit("authentication", {
        operationId,
        state: "starting",
        message: "Starting GitHub device authentication.",
      });
      const entrypoint = path.join(
        this.options.releaseRoot,
        "node_modules",
        "@jeffreycao",
        "copilot-api",
        "dist",
        "main.js",
      );
      const child = spawn(
        this.options.nodePath,
        [entrypoint, "auth", "login", "--provider", "copilot"],
        {
          cwd: this.options.releaseRoot,
          env: nodeEnvironment({
            COPILOT_API_HOME: path.join(context.paths.root, "data", "backend"),
            HOST: "127.0.0.1",
          }),
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      this.authentication = child;
      const forward = (chunk: Buffer) => {
        this.emit("authentication", {
          operationId,
          state: "waiting",
          message: redact(chunk.toString("utf8")).trim(),
        });
      };
      child.stdout?.on("data", forward);
      child.stderr?.on("data", forward);
      const timeout = setTimeout(() => child.kill("SIGTERM"), 15 * 60_000);
      timeout.unref();
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });
      clearTimeout(timeout);
      this.authentication = null;
      const tokenPath = path.join(
        context.paths.root,
        "data",
        "backend",
        "github_token",
      );
      const token = await readFile(tokenPath, "utf8").catch(() => "");
      if (exitCode !== 0 || token.trim().length === 0) {
        this.emit("authentication", {
          operationId,
          state: "failed",
          message: `Authentication failed with exit code ${exitCode ?? "unknown"}.`,
        });
        if (wasRunning) {
          await this.start().catch((error: unknown) => {
            this.emit(
              "diagnostic",
              error instanceof Error ? error.message : String(error),
            );
          });
        }
        return;
      }
      await this.options.credentialVault?.seal();
      this.emit("authentication", {
        operationId,
        state: "authenticated",
        message: "GitHub authentication completed.",
      });
      if (wasRunning) {
        await this.start();
      }
      this.emit("changed");
    })().catch((error: unknown) => {
      this.authentication = null;
      this.emit("authentication", {
        operationId,
        state: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    });
    return { operationId };
  }

  cancelAuthentication() {
    if (this.authentication?.exitCode === null) {
      this.authentication.kill("SIGTERM");
    }
  }

  async dispose() {
    this.cancelAuthentication();
    await this.stop(true);
  }
}
