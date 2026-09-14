import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const PAYLOAD_DIR = join(PACKAGE_DIR, "payload");
export const GATEWAY_SCRIPT = join(PAYLOAD_DIR, "gateway.ps1");
export const PRODUCT_NAME = "GitHub Model Relay";
export const PACKAGE_NAME = "githubrelay";
export const RELEASE_REPO = process.env.GITHUBRELAY_RELEASE_REPO ?? "saketlunker/githubRelay";
export const MANIFEST_URL =
  process.env.GITHUBRELAY_MANIFEST_URL ??
  `https://raw.githubusercontent.com/${RELEASE_REPO}/main/releases/prod/latest.json`;

export const MINIMUM_NODE = "22.13.0";

export function packageVersion() {
  return JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")).version;
}

export function isWindows() {
  return process.platform === "win32";
}

/**
 * Windows PowerShell 5.1 ships with Windows and is enough for the gateway module,
 * but prefer PowerShell 7 when the user already has it.
 */
export function resolvePowerShell() {
  for (const candidate of ["pwsh.exe", "pwsh", "powershell.exe", "powershell"]) {
    const probe = spawnSync(candidate, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (!probe.error && probe.status === 0) {
      const major = Number.parseInt((probe.stdout ?? "").trim(), 10);
      if (Number.isFinite(major) && major >= 5) {
        return { command: candidate, majorVersion: major };
      }
    }
  }
  return undefined;
}

export function payloadInstalled() {
  return existsSync(GATEWAY_SCRIPT);
}

export function compareVersions(left, right) {
  const parse = (value) =>
    String(value)
      .split(".")
      .map((part) => {
        const parsed = Number.parseInt(part, 10);
        return Number.isFinite(parsed) ? parsed : 0;
      });
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Device authentication needs a real console, so interactive commands must not
 * run PowerShell with -NonInteractive.
 */
export function runGateway(command, args = [], { interactive = false, capture = false } = {}) {
  if (!payloadInstalled()) {
    throw new Error(
      `The ${PRODUCT_NAME} payload is missing from the package. Reinstall with: npm install -g ${PACKAGE_NAME}@latest`,
    );
  }
  const shell = resolvePowerShell();
  if (!shell) {
    throw new Error("PowerShell was not found. Windows PowerShell 5.1 or PowerShell 7 is required.");
  }
  const shellArguments = ["-NoProfile"];
  if (!interactive) shellArguments.push("-NonInteractive");
  shellArguments.push("-ExecutionPolicy", "Bypass", "-File", GATEWAY_SCRIPT, command, ...args);

  return spawnSync(shell.command, shellArguments, {
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: capture ? "utf8" : undefined,
    cwd: PAYLOAD_DIR,
  });
}

export function runGatewayJson(command, args = []) {
  const result = runGateway(command, [...args, "-Json"], { capture: true });
  if (result.error || result.status !== 0) {
    return { ok: false, error: (result.stderr || result.error?.message || "").trim() };
  }
  try {
    return { ok: true, value: JSON.parse(result.stdout) };
  } catch {
    return { ok: false, error: (result.stdout ?? "").trim() };
  }
}

/**
 * Runs a gateway command while still showing its output live, handing each
 * completed line to `onLine`. Used by device sign-in, which needs the code to
 * be noticed as it is printed rather than after the command finishes.
 */
export function runGatewayWatched(command, args = [], { onLine } = {}) {
  return new Promise((resolve) => {
    if (!payloadInstalled()) {
      return resolve({ status: 1, error: new Error(`The ${PRODUCT_NAME} payload is missing from the package.`) });
    }
    const shell = resolvePowerShell();
    if (!shell) {
      return resolve({ status: 1, error: new Error("PowerShell was not found.") });
    }

    const child = spawn(
      shell.command,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", GATEWAY_SCRIPT, command, ...args],
      { cwd: PAYLOAD_DIR, stdio: ["inherit", "pipe", "pipe"] },
    );

    let pending = "";
    const forward = (chunk, stream) => {
      const text = chunk.toString();
      stream.write(text);
      if (!onLine) return;
      pending += text;
      let index;
      while ((index = pending.indexOf("\n")) !== -1) {
        onLine(pending.slice(0, index));
        pending = pending.slice(index + 1);
      }
    };

    child.stdout.on("data", (chunk) => forward(chunk, process.stdout));
    child.stderr.on("data", (chunk) => forward(chunk, process.stderr));
    child.on("error", (error) => resolve({ status: 1, error }));
    child.on("close", (code) => {
      if (pending && onLine) onLine(pending);
      resolve({ status: code ?? 0 });
    });
  });
}
