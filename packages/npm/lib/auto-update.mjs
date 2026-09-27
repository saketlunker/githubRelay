import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { PACKAGE_DIR, isWindows, packageVersion, resolvePowerShell } from "./environment.mjs";
import { ensureGatewayCurrent } from "./gateway-sync.mjs";
import { launcherStateDir, readLauncherState, updateLauncherState } from "./launcher-state.mjs";
import { acquireUpdateLock } from "./update-lock.mjs";
import { checkForUpdate } from "./update.mjs";

// Bump when the task definition changes, so existing installs re-register it.
const TASK_DEFINITION = 1;
// Late enough for Wi-Fi and the relay itself to come up after sign-in, early
// enough to be done before most people start working. An update restarts the
// relay, which is why it runs here and not in the middle of the day.
export const SIGN_IN_DELAY = "PT30S";
// About two minutes of retries, for a network that is still connecting.
const MANIFEST_ATTEMPTS = 8;
const MANIFEST_RETRY_DELAY_MS = 5_000;
const LOG_LIMIT_BYTES = 256 * 1024;

// The same per-user name scheme as the gateway's own task.
const TASK_NAME_SCRIPT = [
  "$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
  "$sha = [Security.Cryptography.SHA256]::Create()",
  "$hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($sid))).Replace('-', '').ToLowerInvariant().Substring(0, 10)",
  "$name = \"GitHubRelay-Update-$hash\"",
].join("; ");

const REGISTER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Import-Module ScheduledTasks",
  TASK_NAME_SCRIPT,
  "$identity = [Security.Principal.WindowsIdentity]::GetCurrent()",
  "$powerShell = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
  "$action = New-ScheduledTaskAction -Execute $powerShell -Argument $env:GITHUBRELAY_TASK_ARGUMENTS",
  "$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name",
  "$trigger.Delay = $env:GITHUBRELAY_TASK_DELAY",
  "$principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited",
  "$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries",
  "Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Installs GitHub Model Relay updates when you sign in.' -Force | Out-Null",
  "Write-Output $name",
].join("; ");

const REMOVE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Import-Module ScheduledTasks",
  TASK_NAME_SCRIPT,
  "if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $name -Confirm:$false }",
].join("; ");

const STATUS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Import-Module ScheduledTasks",
  TASK_NAME_SCRIPT,
  "$task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue",
  "if (-not $task) { @{ name = $name; registered = $false } | ConvertTo-Json -Compress; return }",
  "$info = $task | Get-ScheduledTaskInfo",
  "@{ name = $name; registered = $true; state = [string]$task.State; lastRun = $info.LastRunTime.ToString('o'); lastResult = $info.LastTaskResult } | ConvertTo-Json -Compress",
].join("; ");

/**
 * The task runs the launcher through a hidden Windows PowerShell, the way the
 * gateway's own task starts it, so no console window appears at sign-in.
 */
export function updateTaskArguments({ node, script }) {
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  return `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command "& ${quote(node)} ${quote(script)} auto-update"`;
}

export function updateTaskTarget() {
  return {
    definition: TASK_DEFINITION,
    node: process.execPath,
    script: join(PACKAGE_DIR, "bin", "githubrelay.js"),
  };
}

export function sameTaskTarget(recorded, target) {
  return recorded?.definition === target.definition
    && recorded?.node === target.node
    && recorded?.script === target.script;
}

function gatewayInstalledOnDisk() {
  const root = process.env.LOCALAPPDATA;
  return Boolean(root) && existsSync(join(root, "CopilotHarnessGateway", "state", "install.json"));
}

function firstLine(text) {
  return String(text ?? "").trim().split(/\r?\n/)[0] || "unknown error";
}

function runTaskScript(script, env = {}) {
  if (!isWindows()) return { ok: false, reason: "Windows only" };
  const shell = resolvePowerShell();
  if (!shell) return { ok: false, reason: "PowerShell not found" };
  const result = spawnSync(shell.command, ["-NoProfile", "-NonInteractive", "-Command", script], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (result.error || result.status !== 0) {
    return { ok: false, reason: firstLine(result.stderr || result.error?.message) };
  }
  return { ok: true, output: (result.stdout ?? "").trim() };
}

export function registerUpdateTask() {
  const target = updateTaskTarget();
  const result = runTaskScript(REGISTER_SCRIPT, {
    GITHUBRELAY_TASK_ARGUMENTS: updateTaskArguments(target),
    GITHUBRELAY_TASK_DELAY: SIGN_IN_DELAY,
  });
  if (!result.ok) {
    // Remembered so a machine that refuses the task is not asked on every command.
    updateLauncherState({ updateTaskFailed: { ...target, reason: result.reason } });
    return result;
  }
  updateLauncherState({ updateTask: { ...target, name: result.output }, updateTaskFailed: undefined });
  return { ok: true, name: result.output };
}

/**
 * Adds the sign-in update task to an install that predates it, and repairs it
 * when Node or the launcher moved. Costs a file read once it is in place.
 */
export function ensureUpdateTask() {
  if (!isWindows() || !gatewayInstalledOnDisk()) return { changed: false };
  const state = readLauncherState();
  const target = updateTaskTarget();
  if (sameTaskTarget(state.updateTask, target) || sameTaskTarget(state.updateTaskFailed, target)) {
    return { changed: false };
  }
  return { changed: true, ...registerUpdateTask() };
}

export function removeUpdateTask() {
  const result = runTaskScript(REMOVE_SCRIPT);
  if (result.ok) updateLauncherState({ updateTask: undefined, updateTaskFailed: undefined });
  return result;
}

export function updateTaskStatus() {
  const result = runTaskScript(STATUS_SCRIPT);
  if (!result.ok) return { error: result.reason };
  try {
    return JSON.parse(result.output);
  } catch {
    return { error: firstLine(result.output) };
  }
}

export function autoUpdateLogPath() {
  return join(launcherStateDir(), "auto-update.log");
}

/** Appends timestamped lines, keeping one previous file once it grows large. */
export function createLogWriter(path = autoUpdateLogPath(), { limit = LOG_LIMIT_BYTES, now = () => new Date() } = {}) {
  return (text) => {
    const lines = String(text).split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length === 0) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      if (existsSync(path) && statSync(path).size > limit) renameSync(path, `${path}.1`);
      const stamp = now().toISOString();
      appendFileSync(path, lines.map((line) => `${stamp} [${process.pid}] ${line}\n`).join(""), "utf8");
    } catch {
      // Logging must never be the reason an update fails.
    }
  };
}

export function readLogTail(lines = 20, path = autoUpdateLogPath()) {
  try {
    return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).slice(-lines);
  } catch {
    return [];
  }
}

/** Nobody sees the hidden console, so everything the launcher prints goes to the log. */
function captureOutput(write) {
  for (const stream of [process.stdout, process.stderr]) {
    stream.write = (chunk, encoding, callback) => {
      write(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      const done = typeof encoding === "function" ? encoding : callback;
      if (typeof done === "function") done();
      return true;
    };
  }
}

/**
 * What the sign-in task runs: update the launcher, then the gateway, then
 * re-link the agents. A launcher update re-runs this command on the new
 * version, which carries on from the gateway step.
 */
export async function runAutoUpdate() {
  const write = createLogWriter();
  captureOutput(write);
  const updatedFrom = process.env.GITHUBRELAY_UPDATED_FROM;
  write(updatedFrom
    ? `now on launcher ${packageVersion()}, updated from ${updatedFrom}`
    : `checking for updates; launcher ${packageVersion()}`);

  const finish = (outcome) => {
    updateLauncherState({
      lastAutoUpdate: { at: new Date().toISOString(), launcher: packageVersion(), updatedFrom, ...outcome },
    });
    write(`done: ${JSON.stringify(outcome)}`);
    process.exit(0);
  };

  const lock = acquireUpdateLock();
  if (!lock.acquired) {
    return finish({ result: "skipped", reason: `another update is running (pid ${lock.holder?.pid ?? "unknown"})` });
  }
  process.on("exit", lock.release);

  await checkForUpdate({ quiet: false, manifestAttempts: MANIFEST_ATTEMPTS, retryDelayMs: MANIFEST_RETRY_DELAY_MS });
  const gateway = ensureGatewayCurrent({ announce: write, relink: true });
  return finish({
    result: "ok",
    gateway: gateway.changed ? `updated ${gateway.from} -> ${gateway.to}` : gateway.reason,
  });
}

function describeLastRun(status) {
  if (!status.lastRun || new Date(status.lastRun).getFullYear() < 2000) return "not run yet";
  return `last run ${status.lastRun}, result ${status.lastResult}`;
}

export function formatAutoUpdate(status, state, logTail = []) {
  const lines = [];
  if (status?.error) {
    lines.push(`sign-in task: unknown (${status.error})`);
  } else if (status?.registered) {
    lines.push(`sign-in task: ${status.name}, ${String(status.state).toLowerCase()}, ${describeLastRun(status)}`);
  } else {
    const failed = state?.updateTaskFailed?.reason;
    lines.push(`sign-in task: missing${failed ? ` (${failed})` : ""}; run 'githubrelay setup' to add it`);
  }

  const last = state?.lastAutoUpdate;
  if (last) {
    const launcher = last.updatedFrom ? `${last.updatedFrom} -> ${last.launcher}` : `${last.launcher}, no update`;
    lines.push(`last automatic update: ${last.at}; launcher ${launcher}; gateway ${last.gateway ?? last.reason ?? last.result}`);
  } else {
    lines.push("last automatic update: none recorded yet");
  }

  if (logTail.length > 0) {
    lines.push("", "```", ...logTail, "```");
  }
  return lines.join("\n");
}
