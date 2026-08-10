import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  ModelAliasTargetError,
  buildAliases,
  createCatalogFromPayload,
  discoverModels,
  isLoopbackAddress,
  readModelCache,
  validateGatewayConfig,
} from '../../runtime/lib/model-catalog.mjs';
import {
  parseModelsCliArgs,
  runModelsCli,
} from '../../runtime/models-cli.mjs';

const FIXED_TIME = new Date('2026-08-10T00:00:00.000Z');
const TEST_OUTPUT = path.resolve(import.meta.dirname, '..', '..', '.test-output');

async function makeRoot(t, {
  address = '127.0.0.1',
  port = 4141,
  aliases = {},
  ttl = 900,
} = {}) {
  await mkdir(TEST_OUTPUT, { recursive: true });
  const root = await mkdtemp(path.join(TEST_OUTPUT, 'gateway model catalog -'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'config'), { recursive: true });
  await writeFile(
    path.join(root, 'config', 'gateway.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      listen: { address, port },
      models: {
        refreshTtlSeconds: ttl,
        aliases,
      },
    }, null, 2)}\n`,
  );
  return root;
}

async function writeModelsFixture(root, payload) {
  const fixture = path.join(root, 'models-fixture.json');
  await writeFile(fixture, `${JSON.stringify(payload, null, 2)}\n`);
  return fixture;
}

function fixturePayload() {
  return {
    backendVersion: '2.0.1',
    data: [
      {
        id: 'claude-sonnet-4-20250514',
        object: 'model',
        owned_by: 'anthropic',
      },
      {
        id: 'claude-sonnet-4-20260101',
        object: 'model',
        prompt: 'must-not-be-cached',
        apiKey: 'must-not-be-cached',
      },
      { id: 'claude-opus-5', object: 'model' },
      { id: 'claude-haiku-3.5', object: 'model' },
      { id: 'gpt-5.2-codex', object: 'model' },
      { id: 'gpt-5-mini', object: 'model' },
      {
        id: 'gpt-5-mini',
        object: 'duplicate-must-not-replace-first',
      },
    ],
  };
}

test('fixture discovery is offline, de-duplicates IDs, sanitizes metadata, and builds dynamic aliases', async (t) => {
  const root = await makeRoot(t);
  const fixture = await writeModelsFixture(root, fixturePayload());
  let fetchCalled = false;

  const catalog = await discoverModels({
    root,
    modelsFile: fixture,
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error('network must not be used');
    },
    now: () => FIXED_TIME,
  });

  assert.equal(fetchCalled, false);
  assert.equal(catalog.schemaVersion, 1);
  assert.equal(catalog.discoveredAt, FIXED_TIME.toISOString());
  assert.equal(catalog.backendVersion, '2.0.1');
  assert.match(catalog.responseHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    catalog.models.map((model) => model.id),
    [
      'claude-haiku-3.5',
      'claude-opus-5',
      'claude-sonnet-4-20250514',
      'claude-sonnet-4-20260101',
      'gpt-5-mini',
      'gpt-5.2-codex',
    ],
  );
  assert.equal(
    catalog.models.find((model) => model.id === 'gpt-5-mini').object,
    'model',
  );
  const sanitized = catalog.models.find(
    (model) => model.id === 'claude-sonnet-4-20260101',
  );
  assert.equal(Object.hasOwn(sanitized, 'prompt'), false);
  assert.equal(Object.hasOwn(sanitized, 'apiKey'), false);
  assert.deepEqual(catalog.aliases, {
    default: 'claude-sonnet-4-20260101',
    claude: 'claude-sonnet-4-20260101',
    codex: 'gpt-5.2-codex',
    fast: 'claude-haiku-3.5',
  });
});

test('explicit aliases are preserved and unavailable explicit targets are never retargeted', () => {
  const ids = [
    'claude-sonnet-4',
    'claude-opus-5',
    'gpt-5-codex',
    'gpt-5-mini',
  ];
  const aliases = buildAliases(ids, {
    claude: 'claude-opus-5',
    release: 'gpt-5-codex',
  });

  assert.equal(aliases.claude, 'claude-opus-5');
  assert.equal(aliases.release, 'gpt-5-codex');
  assert.throws(
    () => buildAliases(ids, { claude: 'claude-sonnet-removed' }),
    (error) =>
      error instanceof ModelAliasTargetError
      && error.code === 'MODEL_ALIAS_TARGET_MISSING',
  );
});

test('model responses require a non-empty data array with safe IDs', () => {
  assert.throws(
    () => createCatalogFromPayload({ models: [{ id: 'gpt-5' }] }),
    /data array/,
  );
  assert.throws(
    () => createCatalogFromPayload({ data: [] }),
    /no usable models/,
  );
  assert.throws(
    () => createCatalogFromPayload({ data: [{ id: 'bad\u001bmodel' }] }),
    /safe ASCII/,
  );
});

test('gateway listeners are restricted to numeric loopback addresses', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('127.20.30.40'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('localhost'), false);
  assert.equal(isLoopbackAddress('0.0.0.0'), false);
  assert.equal(isLoopbackAddress('192.168.1.2'), false);

  const valid = {
    schemaVersion: 1,
    listen: { address: '127.0.0.1', port: 4141 },
    models: { refreshTtlSeconds: 900, aliases: {} },
  };
  assert.equal(validateGatewayConfig(valid).listen.port, 4141);
  assert.throws(
    () => validateGatewayConfig({
      ...valid,
      listen: { address: '0.0.0.0', port: 4141 },
    }),
    (error) => error.code === 'NON_LOOPBACK_LISTENER',
  );
});

test('models CLI refresh uses a fixture without secrets and writes only safe catalog output', async (t) => {
  const root = await makeRoot(t);
  const fixture = await writeModelsFixture(root, fixturePayload());
  const outputChunks = [];
  const options = parseModelsCliArgs([
    'refresh',
    '--root',
    root,
    '--models-file',
    fixture,
    '--timeout-ms',
    '5000',
  ]);

  const output = await runModelsCli(options, {
    fetchImpl: async () => {
      throw new Error('network must not be used');
    },
    now: () => FIXED_TIME,
    stdout: (chunk) => outputChunks.push(chunk),
  });

  assert.equal(output.models.includes('gpt-5.2-codex'), true);
  assert.equal(output.aliases.default, 'claude-sonnet-4-20260101');
  const rendered = outputChunks.join('');
  assert.equal(rendered.includes('must-not-be-cached'), false);
  assert.equal(rendered.includes('x-api-key'), false);
  const cached = await readModelCache(root);
  assert.deepEqual(
    cached.models.map((model) => model.id),
    output.models,
  );
  assert.deepEqual(cached.aliases, output.aliases);
});

test('set-alias validates discovery, updates config/cache, and backs up only a changed config', async (t) => {
  const root = await makeRoot(t);
  const fixture = await writeModelsFixture(root, fixturePayload());
  const options = parseModelsCliArgs([
    'set-alias',
    '--root',
    root,
    '--models-file',
    fixture,
    '--alias',
    'workhorse',
    '--model',
    'gpt-5.2-codex',
  ]);

  await runModelsCli(options, {
    now: () => FIXED_TIME,
    backupNow: () => FIXED_TIME,
    stdout: () => {},
  });

  const config = JSON.parse(await readFile(path.join(root, 'config', 'gateway.json'), 'utf8'));
  const cache = await readModelCache(root);
  assert.equal(config.models.aliases.workhorse, 'gpt-5.2-codex');
  assert.equal(cache.aliases.workhorse, 'gpt-5.2-codex');
  const adjacent = await readdir(path.join(root, 'config'));
  assert.equal(
    adjacent.filter((name) => name.startsWith('gateway.json.backup-')).length,
    1,
  );

  await assert.rejects(
    runModelsCli({
      ...options,
      alias: 'missing',
      model: 'gpt-removed',
    }, {
      now: () => FIXED_TIME,
      stdout: () => {},
    }),
    /unavailable model|not present/,
  );
});

test('models CLI argument parsing is strict and bounds timeouts', () => {
  assert.throws(() => parseModelsCliArgs([]), /--root is required/);
  assert.throws(
    () => parseModelsCliArgs(['list', '--root', '.', '--unknown', 'x']),
    /Unknown option/,
  );
  assert.throws(
    () => parseModelsCliArgs(['refresh', '--root', '.', '--timeout-ms', '99']),
    /100 through 120000/,
  );
  assert.throws(
    () => parseModelsCliArgs(['set-alias', '--root', '.', '--alias', 'x']),
    /both --alias NAME and --model ID/,
  );
});
