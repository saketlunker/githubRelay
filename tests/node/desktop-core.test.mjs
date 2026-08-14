import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { initializeDesktopState } from '../../runtime/lib/desktop-state.mjs';
import {
  buildProbeRequest,
  modelCapabilitySummary,
} from '../../runtime/lib/model-capabilities.mjs';
import { resolveDesktopPaths } from '../../runtime/lib/platform-paths.mjs';
import {
  canonicalJson,
  selectReleaseAsset,
  verifyReleaseAsset,
  verifyReleaseManifest,
} from '../../runtime/lib/release-manifest.mjs';
import {
  stageLegacyWindowsMigration,
} from '../../runtime/lib/windows-migration.mjs';

test('platform paths are deterministic and reject unsupported systems', () => {
  assert.equal(
    resolveDesktopPaths({
      platform: 'win32',
      home: 'C:\\Users\\octo',
      env: { LOCALAPPDATA: 'C:\\Users\\octo\\AppData\\Local' },
    }).root,
    path.win32.resolve('C:\\Users\\octo\\AppData\\Local', 'GitHubModelRelay'),
  );
  assert.equal(
    resolveDesktopPaths({
      platform: 'darwin',
      home: '/Users/octo',
      env: {},
    }).root,
    path.posix.resolve('/Users/octo/Library/Application Support/GitHub Model Relay'),
  );
  assert.equal(
    resolveDesktopPaths({
      platform: 'linux',
      home: '/home/octo',
      env: { XDG_STATE_HOME: '/state', XDG_CACHE_HOME: '/cache' },
    }).root,
    path.posix.resolve('/state/github-model-relay'),
  );
  assert.throws(
    () => resolveDesktopPaths({ platform: 'aix', home: '/home/octo', env: {} }),
    /Unsupported desktop platform/,
  );
});

test('unknown safe reasoning values survive model planning without fallback', () => {
  const model = {
    id: 'gptx-9.99',
    vendor: 'Future Vendor',
    supported_endpoints: ['/responses'],
    capabilities: {
      supports: {
        reasoning_effort: ['low', 'max', 'extra-max'],
        streaming: true,
        tool_calls: true,
      },
      limits: { max_context_window_tokens: 2_000_000 },
    },
  };
  const summary = modelCapabilitySummary(model);
  assert.deepEqual(summary.reasoningEfforts, ['low', 'max', 'extra-max']);
  const probe = buildProbeRequest({
    model,
    endpoint: '/responses',
    reasoningEffort: 'extra-max',
  });
  assert.equal(probe.body.model, 'gptx-9.99');
  assert.equal(probe.body.reasoning.effort, 'extra-max');
  assert.throws(
    () => buildProbeRequest({
      model,
      endpoint: '/responses',
      reasoningEffort: 'ultra-secret',
    }),
    /does not advertise/,
  );
});

test('desktop state is idempotent and provisions an immutable desktop release', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'model-relay-state-'));
  const root = path.join(temporary, 'state');
  const releaseRoot = path.join(temporary, 'release');
  await mkdir(path.join(releaseRoot, 'runtime'), { recursive: true });
  await mkdir(
    path.join(
      releaseRoot,
      'node_modules',
      '@jeffreycao',
      'copilot-api',
      'dist',
    ),
    { recursive: true },
  );
  await writeFile(path.join(releaseRoot, 'runtime', 'supervisor.mjs'), '');
  await writeFile(
    path.join(
      releaseRoot,
      'node_modules',
      '@jeffreycao',
      'copilot-api',
      'dist',
      'main.js',
    ),
    '',
  );
  let sequence = 1;
  const randomBytesImpl = (size) => Buffer.alloc(size, sequence++);
  const options = {
    root,
    releaseRoot,
    nodePath: process.execPath,
    appVersion: '0.2.0',
    backendVersion: '2.0.1',
    now: () => new Date('2026-08-14T00:00:00.000Z'),
    randomBytesImpl,
    skipAcl: true,
  };
  const first = await initializeDesktopState(options);
  const second = await initializeDesktopState(options);
  assert.equal(first.install.mode, 'desktop');
  assert.equal(first.install.runtimeMode, 'electron-node');
  assert.equal(first.install.activeVersionId, 'desktop-0.2.0-backend-2.0.1');
  assert.equal(second.secrets.clientApiKey, first.secrets.clientApiKey);
  assert.notEqual(first.secrets.clientApiKey, first.secrets.internalApiKey);
  const upstream = JSON.parse(await readFile(first.paths.backendConfig, 'utf8'));
  assert.deepEqual(upstream.auth.apiKeys, [first.secrets.internalApiKey]);
  assert.equal(upstream.auth.adminApiKey, first.secrets.adminApiKey);
});

test('Windows migration stages only allowlisted legacy state and preserves desired state', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'model-relay-migration-'));
  const legacy = path.join(temporary, 'legacy');
  const target = path.join(temporary, 'desktop');
  await Promise.all([
    mkdir(path.join(legacy, 'config'), { recursive: true }),
    mkdir(path.join(legacy, 'secrets'), { recursive: true }),
    mkdir(path.join(legacy, 'state'), { recursive: true }),
    mkdir(path.join(legacy, 'data', 'backend'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      path.join(legacy, '.copilot-harness-gateway-root.json'),
      JSON.stringify({ product: 'CopilotHarnessGateway' }),
    ),
    writeFile(
      path.join(legacy, 'config', 'gateway.json'),
      JSON.stringify({
        listen: { address: '127.0.0.1', port: 4141 },
        backend: { address: '127.0.0.1', port: 4142 },
      }),
    ),
    writeFile(
      path.join(legacy, 'secrets', 'secrets.json'),
      JSON.stringify({
        clientApiKey: 'c'.repeat(43),
        internalApiKey: 'i'.repeat(43),
        adminApiKey: 'a'.repeat(43),
      }),
    ),
    writeFile(
      path.join(legacy, 'state', 'desired-state.json'),
      JSON.stringify({ schemaVersion: 1, state: 'running' }),
    ),
    writeFile(path.join(legacy, 'data', 'backend', 'github_token'), 'token'),
    writeFile(path.join(legacy, 'ignored.txt'), 'must not migrate'),
  ]);
  const response = { status: 202 };
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      return response;
    }
    throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
  };
  const record = await stageLegacyWindowsMigration({
    legacyRoot: legacy,
    targetRoot: target,
    platform: 'win32',
    fetchImpl,
    now: () => new Date('2026-08-14T00:00:00.000Z'),
  });
  assert.equal(record.legacyWasRunning, true);
  const settings = JSON.parse(
    await readFile(path.join(target, 'state', 'desktop-settings.json'), 'utf8'),
  );
  assert.equal(settings.launchAtLogin, true);
  assert.equal(settings.closeToTray, true);
  assert.equal(
    await readFile(path.join(target, 'data', 'backend', 'github_token'), 'utf8'),
    'token',
  );
  await assert.rejects(readFile(path.join(target, 'ignored.txt')), /ENOENT/);
  const recordPath = path.join(target, 'state', 'desktop-migration.json');
  await writeFile(
    recordPath,
    JSON.stringify({ ...record, state: 'completed' }),
  );
  let protectionCalls = 0;
  const completed = await stageLegacyWindowsMigration({
    legacyRoot: legacy,
    targetRoot: target,
    platform: 'win32',
    fetchImpl,
    protectTree: () => {
      protectionCalls += 1;
    },
  });
  assert.equal(completed, null);
  assert.equal(protectionCalls, 0);
});

test('release manifest requires a valid signature, target, schema, and asset hash', () => {
  const content = Buffer.from('signed application');
  const hash = createHash('sha256')
    .update(content)
    .digest('hex');
  const manifest = {
    schemaVersion: 1,
    product: 'github-model-relay',
    version: '0.2.0',
    channel: 'stable',
    publishedAt: '2026-08-14T00:00:00.000Z',
    minimumSchemas: {
      application: 1,
      data: 1,
      gateway: 1,
      clientOwnership: 1,
    },
    assets: [{
      name: 'GitHub-Model-Relay-0.2.0-win-x64.exe',
      platform: 'win32',
      arch: 'x64',
      format: 'nsis',
      size: content.length,
      sha256: hash,
    }],
    signing: { policy: 'fixture-policy' },
  };
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signature = sign(
    null,
    Buffer.from(canonicalJson(manifest), 'utf8'),
    privateKey,
  );
  const verified = verifyReleaseManifest({
    manifest,
    signature,
    publicKey,
    expectedChannel: 'stable',
    currentSchemas: {
      application: 1,
      data: 1,
      gateway: 1,
      clientOwnership: 1,
    },
  });
  const asset = selectReleaseAsset(verified, {
    platform: 'win32',
    arch: 'x64',
    format: 'nsis',
  });
  assert.equal(verifyReleaseAsset(asset, content), true);
  assert.throws(
    () => verifyReleaseManifest({
      manifest: { ...manifest, version: '0.2.1' },
      signature,
      publicKey,
      expectedChannel: 'stable',
      currentSchemas: {
        application: 1,
        data: 1,
        gateway: 1,
        clientOwnership: 1,
      },
    }),
    /signature is invalid/,
  );
});
