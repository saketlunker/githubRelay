import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  atomicWriteJson,
  fileExists,
  readJsonFile,
} from './atomic-files.mjs';

export const DESKTOP_STATE_SCHEMAS = Object.freeze({
  application: 1,
  data: 1,
  gateway: 1,
  clientOwnership: 1,
});

export const DEFAULT_GATEWAY_CONFIGURATION = Object.freeze({
  schemaVersion: 1,
  listen: { address: '127.0.0.1', port: 4141 },
  backend: { address: '127.0.0.1', port: 4142 },
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
    maximumFileBytes: 5_242_880,
    retainedFiles: 5,
    captureBackendOutput: false,
  },
  network: { proxyFromEnvironment: false },
  models: { refreshTtlSeconds: 900, aliases: {} },
});

async function directory(directoryPath) {
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    await chmod(directoryPath, 0o700);
  }
}

async function jsonIfMissing(filePath, value, mode = 0o600) {
  if (await fileExists(filePath)) {
    return await readJsonFile(filePath, { required: true, label: filePath });
  }
  await atomicWriteJson(filePath, value, { expectedContent: null, mode });
  if (process.platform !== 'win32') {
    await chmod(filePath, mode);
  }
  return value;
}

function secret(randomBytesImpl) {
  return randomBytesImpl(32).toString('base64url');
}

function protectWindowsRoot(root) {
  const quoted = root.replaceAll("'", "''");
  const script = [
    "$ErrorActionPreference='Stop'",
    "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    `& \"$env:SystemRoot\\System32\\icacls.exe\" '${quoted}' '/inheritance:r' '/grant:r' \"*\${sid}:(OI)(CI)F\" '*S-1-5-18:(OI)(CI)F' '/grant' \"*\${sid}:F\" '*S-1-5-18:F' '/T' '/Q' | Out-Null`,
    "if($LASTEXITCODE -ne 0){throw 'icacls failed'}",
  ].join(';');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000 },
  );
  if (result.status !== 0) {
    throw new Error(`Unable to protect desktop state: ${result.stderr.trim()}`);
  }
}

export async function initializeDesktopState({
  root,
  releaseRoot,
  nodePath,
  appVersion,
  backendVersion,
  now = () => new Date(),
  randomBytesImpl = randomBytes,
  skipAcl = false,
}) {
  const resolvedRoot = path.resolve(root);
  const resolvedReleaseRoot = path.resolve(releaseRoot);
  const resolvedNodePath = path.resolve(nodePath);
  const entrypoint = path.join(
    resolvedReleaseRoot,
    'node_modules',
    '@jeffreycao',
    'copilot-api',
    'dist',
    'main.js',
  );
  const supervisor = path.join(resolvedReleaseRoot, 'runtime', 'supervisor.mjs');
  await Promise.all([stat(entrypoint), stat(supervisor), stat(resolvedNodePath)]);

  const paths = {
    root: resolvedRoot,
    config: path.join(resolvedRoot, 'config', 'gateway.json'),
    secrets: path.join(resolvedRoot, 'secrets', 'secrets.json'),
    install: path.join(resolvedRoot, 'state', 'install.json'),
    desired: path.join(resolvedRoot, 'state', 'desired-state.json'),
    settings: path.join(resolvedRoot, 'state', 'desktop-settings.json'),
    backendConfig: path.join(resolvedRoot, 'data', 'backend', 'config.json'),
    marker: path.join(resolvedRoot, '.github-model-relay-root.json'),
    supervisor,
  };
  for (const item of [
    resolvedRoot,
    path.join(resolvedRoot, 'config'),
    path.join(resolvedRoot, 'secrets'),
    path.join(resolvedRoot, 'state'),
    path.join(resolvedRoot, 'data', 'backend'),
    path.join(resolvedRoot, 'logs'),
    path.join(resolvedRoot, 'backups'),
    path.join(resolvedRoot, 'updates'),
  ]) {
    await directory(item);
  }
  if (process.platform === 'win32' && !skipAcl) {
    protectWindowsRoot(resolvedRoot);
  }

  const timestamp = now().toISOString();
  await jsonIfMissing(paths.marker, {
    schemaVersion: 1,
    product: 'GitHubModelRelay',
    createdAt: timestamp,
  });
  const configuration = await jsonIfMissing(
    paths.config,
    structuredClone(DEFAULT_GATEWAY_CONFIGURATION),
  );
  const secrets = await jsonIfMissing(paths.secrets, {
    schemaVersion: 1,
    clientApiKey: secret(randomBytesImpl),
    internalApiKey: secret(randomBytesImpl),
    adminApiKey: secret(randomBytesImpl),
    createdAt: timestamp,
  });
  for (const name of ['clientApiKey', 'internalApiKey', 'adminApiKey']) {
    if (typeof secrets[name] !== 'string' || secrets[name].length < 32) {
      throw new Error(`Desktop secrets contain an invalid ${name}.`);
    }
  }

  const releaseId = `desktop-${appVersion}-backend-${backendVersion}`;
  const previous = await readJsonFile(paths.install);
  const releases = {
    ...(previous?.releases ?? {}),
    [releaseId]: {
      backendVersion,
      entrypoint: path.relative(resolvedReleaseRoot, entrypoint),
      releaseRoot: resolvedReleaseRoot,
      installedAt: previous?.releases?.[releaseId]?.installedAt ?? timestamp,
    },
  };
  const install = {
    schemaVersion: 1,
    mode: 'desktop',
    activeVersionId: releaseId,
    previousVersionId:
      previous?.activeVersionId && previous.activeVersionId !== releaseId
        ? previous.activeVersionId
        : previous?.previousVersionId ?? null,
    nodePath: resolvedNodePath,
    nodeVersion: process.versions.node,
    runtimeMode: 'electron-node',
    backendPackage: '@jeffreycao/copilot-api',
    releases,
    updatedAt: timestamp,
  };
  await atomicWriteJson(paths.install, install);
  const desired = await jsonIfMissing(paths.desired, {
    schemaVersion: 1,
    state: 'stopped',
    updatedAt: timestamp,
  });
  const settings = await jsonIfMissing(paths.settings, {
    schemaVersion: 1,
    launchAtLogin: false,
    updateChannel: 'stable',
    closeToTray: true,
    createdAt: timestamp,
  });

  const upstream = await readJsonFile(paths.backendConfig) ?? {};
  upstream.auth ??= {};
  const apiKeys = new Set(
    Array.isArray(upstream.auth.apiKeys) ? upstream.auth.apiKeys : [],
  );
  apiKeys.add(secrets.internalApiKey);
  upstream.auth.apiKeys = [...apiKeys];
  upstream.auth.adminApiKey = secrets.adminApiKey;
  await atomicWriteJson(paths.backendConfig, upstream);
  if (process.platform !== 'win32') {
    await chmod(paths.backendConfig, 0o600);
  }

  return {
    paths,
    configuration,
    secrets,
    install,
    desired,
    settings,
    releaseRoot: resolvedReleaseRoot,
  };
}
