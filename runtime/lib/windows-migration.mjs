import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';

import {
  atomicWriteJson,
  fileExists,
  readJsonFile,
} from './atomic-files.mjs';

const RECORD = path.join('state', 'desktop-migration.json');

function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function protectWindowsTree(root) {
  const quoted = path.resolve(root).replaceAll("'", "''");
  const script = [
    "$ErrorActionPreference='Stop'",
    "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    `& \"$env:SystemRoot\\System32\\icacls.exe\" '${quoted}' '/inheritance:r' '/grant:r' \"*\${sid}:(OI)(CI)F\" '*S-1-5-18:(OI)(CI)F' '/grant' \"*\${sid}:F\" '*S-1-5-18:F' '/T' '/Q' | Out-Null`,
    "if($LASTEXITCODE -ne 0){throw 'icacls failed'}",
  ].join(';');
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000 },
  );
  if (result.status !== 0) {
    throw new Error(`Unable to protect migrated state: ${result.stderr.trim()}`);
  }
}

async function safeCopy(source, destination, root) {
  if (!inside(root, source)) {
    throw new Error(`Migration source escapes the legacy root: ${source}`);
  }
  const info = await lstat(source);
  if (info.isSymbolicLink()) {
    throw new Error(`Migration refuses symbolic links: ${source}`);
  }
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true, mode: 0o700 });
    for (const name of await readdir(source)) {
      await safeCopy(
        path.join(source, name),
        path.join(destination, name),
        root,
      );
    }
    return;
  }
  if (!info.isFile()) {
    throw new Error(`Migration refuses non-file content: ${source}`);
  }
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(source, destination);
}

async function optionalCopy(legacyRoot, staging, relative) {
  const source = path.join(legacyRoot, relative);
  if (await fileExists(source)) {
    await safeCopy(source, path.join(staging, relative), legacyRoot);
  }
}

async function shutdownLegacy(configuration, secrets, fetchImpl) {
  try {
    const response = await fetchImpl(
      `http://${configuration.listen.address}:${configuration.listen.port}/_gateway/shutdown`,
      {
        method: 'POST',
        headers: { 'x-gateway-admin': secrets.adminApiKey },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (![202, 503].includes(response.status)) {
      throw new Error(`Legacy shutdown returned HTTP ${response.status}.`);
    }
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      try {
        await fetchImpl(
          `http://${configuration.listen.address}:${configuration.listen.port}/_gateway/health`,
          { signal: AbortSignal.timeout(500) },
        );
      } catch {
        return;
      }
    }
    throw new Error('Legacy gateway did not stop within 15 seconds.');
  } catch (error) {
    if (error?.cause?.code !== 'ECONNREFUSED' && error?.code !== 'ECONNREFUSED') {
      throw error;
    }
  }
}

export async function stageLegacyWindowsMigration({
  legacyRoot,
  targetRoot,
  platform = process.platform,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  protectTree = process.platform === 'win32'
    ? protectWindowsTree
    : () => undefined,
}) {
  if (platform !== 'win32' || !legacyRoot) {
    return null;
  }
  if (await fileExists(targetRoot)) {
    let existing;
    try {
      existing = await readJsonFile(path.join(targetRoot, RECORD));
    } catch (error) {
      if (!['EACCES', 'EPERM'].includes(error?.cause?.code)) {
        throw error;
      }
      protectTree(targetRoot);
      existing = await readJsonFile(path.join(targetRoot, RECORD));
    }
    if (existing?.state !== 'staged') {
      return null;
    }
    const [configuration, secrets] = await Promise.all([
      readJsonFile(path.join(legacyRoot, 'config', 'gateway.json'), {
        required: true,
        label: 'legacy gateway configuration',
      }),
      readJsonFile(path.join(legacyRoot, 'secrets', 'secrets.json'), {
        required: true,
        label: 'legacy gateway secrets',
      }),
    ]);
    await shutdownLegacy(configuration, secrets, fetchImpl);
    return existing;
  }
  const markerPath = path.join(legacyRoot, '.copilot-harness-gateway-root.json');
  if (!await fileExists(markerPath)) {
    return null;
  }
  const marker = await readJsonFile(markerPath, {
    required: true,
    label: 'legacy ownership marker',
  });
  if (marker.product !== 'CopilotHarnessGateway') {
    throw new Error('Legacy root is not owned by CopilotHarnessGateway.');
  }
  const [configuration, secrets, desired] = await Promise.all([
    readJsonFile(path.join(legacyRoot, 'config', 'gateway.json'), {
      required: true,
      label: 'legacy gateway configuration',
    }),
    readJsonFile(path.join(legacyRoot, 'secrets', 'secrets.json'), {
      required: true,
      label: 'legacy gateway secrets',
    }),
    readJsonFile(path.join(legacyRoot, 'state', 'desired-state.json')),
  ]);
  if (
    configuration.listen?.address !== '127.0.0.1'
    || configuration.backend?.address !== '127.0.0.1'
  ) {
    throw new Error('Legacy gateway is not loopback-only.');
  }
  for (const key of ['clientApiKey', 'internalApiKey', 'adminApiKey']) {
    if (typeof secrets[key] !== 'string' || secrets[key].length < 32) {
      throw new Error(`Legacy gateway has an invalid ${key}.`);
    }
  }
  await shutdownLegacy(configuration, secrets, fetchImpl);

  const staging = `${path.resolve(targetRoot)}.migration-${randomBytes(8).toString('hex')}`;
  await mkdir(staging, { recursive: false, mode: 0o700 });
  try {
    for (const relative of [
      path.join('config', 'gateway.json'),
      path.join('secrets', 'secrets.json'),
      path.join('data', 'backend'),
      path.join('state', 'models.json'),
      path.join('state', 'client-ownership.json'),
      path.join('state', 'desired-state.json'),
    ]) {
      await optionalCopy(legacyRoot, staging, relative);
    }
    const record = {
      schemaVersion: 1,
      state: 'staged',
      legacyRoot: path.resolve(legacyRoot),
      legacyWasRunning: desired?.state === 'running',
      stagedAt: now().toISOString(),
    };
    await atomicWriteJson(
      path.join(staging, 'state', 'desktop-settings.json'),
      {
        schemaVersion: 1,
        launchAtLogin: record.legacyWasRunning,
        updateChannel: 'stable',
        closeToTray: true,
        createdAt: record.stagedAt,
      },
    );
    await atomicWriteJson(path.join(staging, RECORD), record);
    await rename(staging, path.resolve(targetRoot));
    protectTree(targetRoot);
    return record;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

function encodedPowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

export async function finalizeLegacyWindowsMigration({
  targetRoot,
  platform = process.platform,
  now = () => new Date(),
}) {
  const recordPath = path.join(targetRoot, RECORD);
  const record = await readJsonFile(recordPath);
  if (record === null || record.state !== 'staged') {
    return null;
  }
  if (platform !== 'win32') {
    throw new Error('Legacy Scheduled Task finalization requires Windows.');
  }
  const quotedRoot = record.legacyRoot.replaceAll("'", "''");
  const script = [
    "$ErrorActionPreference='Stop'",
    `$root='${quotedRoot}'`,
    "$tasks=Get-ScheduledTask -TaskName 'CopilotHarnessGateway-*' -ErrorAction SilentlyContinue",
    "$owned=@($tasks | Where-Object { @($_.Actions | Where-Object { $_.Arguments -like \"*$root*\" }).Count -gt 0 })",
    "foreach($task in $owned){Unregister-ScheduledTask -TaskName $task.TaskName -Confirm:$false}",
  ].join(';');
  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(script)],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000 },
  );
  if (result.status !== 0) {
    throw new Error(`Unable to remove the legacy Scheduled Task: ${result.stderr.trim()}`);
  }
  const completed = {
    ...record,
    state: 'completed',
    completedAt: now().toISOString(),
  };
  await atomicWriteJson(recordPath, completed);
  return completed;
}

export async function rollbackLegacyWindowsMigration({
  targetRoot,
  platform = process.platform,
}) {
  const record = await readJsonFile(path.join(targetRoot, RECORD));
  if (record === null || !record.legacyWasRunning || platform !== 'win32') {
    return false;
  }
  const gateway = path.join(record.legacyRoot, 'gateway.ps1');
  const script = `& '${gateway.replaceAll("'", "''")}' start -TimeoutSeconds 120 | Out-Null`;
  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(script)],
    { encoding: 'utf8', windowsHide: true, timeout: 150_000 },
  );
  return result.status === 0;
}
