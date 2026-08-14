import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  ANTHROPIC_PROVIDER_ID,
  CLAUDE_API_KEY_HELPER,
  claudeApiKeyHelper,
  CODEX_DEFAULTS_BEGIN,
  CODEX_PROVIDER_BEGIN,
  mergeClaudeSettings,
  mergeCodexConfig,
  parseConfigureClientsArgs,
  parseJsoncObject,
  resolveClientPaths,
  runConfigureClients,
} from '../../runtime/configure-clients.mjs';

test('Claude API key helper is platform appropriate', () => {
  assert.equal(claudeApiKeyHelper('win32'), CLAUDE_API_KEY_HELPER);
  assert.equal(
    claudeApiKeyHelper('darwin'),
    '/bin/sh -c \'printf %s "$COPILOT_HARNESS_GATEWAY_API_KEY"\'',
  );
  assert.equal(
    claudeApiKeyHelper('linux'),
    '/bin/sh -c \'printf %s "$COPILOT_HARNESS_GATEWAY_API_KEY"\'',
  );
});

const FIXED_TIME = new Date('2026-08-10T00:00:00.000Z');
const TEST_OUTPUT = path.resolve(import.meta.dirname, '..', '..', '.test-output');

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function makeInstall(t, { aliases = {} } = {}) {
  await mkdir(TEST_OUTPUT, { recursive: true });
  const root = await mkdtemp(path.join(TEST_OUTPUT, 'gateway configure root -'));
  const home = await mkdtemp(path.join(TEST_OUTPUT, 'gateway configure home -'));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(home, { recursive: true, force: true }),
  ]));
  await mkdir(path.join(root, 'config'), { recursive: true });
  await writeFile(
    path.join(root, 'config', 'gateway.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      listen: { address: '127.0.0.1', port: 4141 },
      models: {
        refreshTtlSeconds: 900,
        aliases,
      },
    }, null, 2)}\n`,
  );
  const fixture = path.join(root, 'models-fixture.json');
  await writeFile(
    fixture,
    `${JSON.stringify({
      backendVersion: '2.0.1',
      data: [
        { id: 'claude-sonnet-4-20260101', object: 'model' },
        { id: 'claude-opus-5', object: 'model' },
        { id: 'claude-haiku-3.5', object: 'model' },
        { id: 'gpt-5.2-codex', object: 'model' },
        { id: 'gpt-5-mini', object: 'model' },
      ],
    }, null, 2)}\n`,
  );
  return { root, home, fixture };
}

function configureOptions({ root, home, fixture }, extra = []) {
  return parseConfigureClientsArgs([
    '--root',
    root,
    '--home',
    home,
    '--models-file',
    fixture,
    ...extra,
  ]);
}

function removeOptions({ root, home }, extra = []) {
  return parseConfigureClientsArgs([
    '--root',
    root,
    '--home',
    home,
    '--remove',
    ...extra,
  ]);
}

async function runOffline(options, overrides = {}) {
  const chunks = [];
  const output = await runConfigureClients(options, {
    fetchImpl: async () => {
      throw new Error('network must not be used');
    },
    now: () => FIXED_TIME,
    backupNow: () => FIXED_TIME,
    executableResolver: async () => false,
    stdout: (chunk) => chunks.push(chunk),
    ...overrides,
  });
  return { output, rendered: chunks.join('') };
}

test('Claude merge is deep-targeted, preserves unrelated values, and protects a different helper', () => {
  const current = {
    permissions: {
      allow: ['Read'],
    },
    env: {
      KEEP_ME: 'yes',
    },
    model: 'user/default',
  };
  const merged = mergeClaudeSettings(current, {
    baseUrl: 'http://127.0.0.1:4141',
    claudeModel: 'claude-sonnet-4',
    sonnetModel: 'claude-sonnet-4',
    opusModel: 'claude-opus-5',
    fastModel: 'claude-haiku-3.5',
    setDefault: false,
  });

  assert.deepEqual(merged.permissions, current.permissions);
  assert.equal(merged.env.KEEP_ME, 'yes');
  assert.equal(merged.model, 'user/default');
  assert.equal(merged.apiKeyHelper, CLAUDE_API_KEY_HELPER);
  assert.equal(merged.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4141');
  assert.equal(merged.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-opus-5');
  assert.equal(current.apiKeyHelper, undefined, 'the input object is not mutated');

  assert.throws(
    () => mergeClaudeSettings(
      { apiKeyHelper: 'another helper' },
      {
        baseUrl: 'http://127.0.0.1:4141',
        claudeModel: 'claude-sonnet-4',
        fastModel: 'claude-haiku-3.5',
      },
    ),
    /different apiKeyHelper/,
  );
});

test('Claude configuration backs up changed files and byte-identical reruns create no extra backup', async (t) => {
  const install = await makeInstall(t);
  const settingsPath = path.join(install.home, '.claude', 'settings.json');
  await mkdir(path.dirname(settingsPath), { recursive: true });
  const original = {
    permissions: { allow: ['Read'] },
    env: { KEEP_ME: 'yes' },
    model: 'user/default',
  };
  const originalText = `${JSON.stringify(original, null, 4)}\n`;
  await writeFile(settingsPath, originalText);

  const options = configureOptions(install, ['--clients', 'claude']);
  const first = await runOffline(options);
  const configuredText = await readFile(settingsPath, 'utf8');
  const configured = JSON.parse(configuredText);
  assert.equal(configured.permissions.allow[0], 'Read');
  assert.equal(configured.env.KEEP_ME, 'yes');
  assert.equal(configured.model, 'user/default');
  assert.equal(configured.apiKeyHelper, CLAUDE_API_KEY_HELPER);
  assert.equal(
    configured.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    'claude-sonnet-4-20260101',
  );
  assert.equal(first.output.clients[0].installation, 'not-installed');
  assert.equal(first.rendered.includes('generated'), true);

  const directoryAfterFirst = await readdir(path.dirname(settingsPath));
  const backupsAfterFirst = directoryAfterFirst.filter(
    (name) => name.startsWith('settings.json.backup-'),
  );
  assert.equal(backupsAfterFirst.length, 1);
  assert.equal(
    await readFile(path.join(path.dirname(settingsPath), backupsAfterFirst[0]), 'utf8'),
    originalText,
  );

  await runOffline(options);
  assert.equal(await readFile(settingsPath, 'utf8'), configuredText);
  const directoryAfterSecond = await readdir(path.dirname(settingsPath));
  assert.equal(
    directoryAfterSecond.filter((name) => name.startsWith('settings.json.backup-')).length,
    1,
  );
});

test('Claude family mapping never assigns a non-Claude fast model', async (t) => {
  const install = await makeInstall(t);
  const payload = JSON.parse(await readFile(install.fixture, 'utf8'));
  payload.data = payload.data.filter((model) => !model.id.includes('haiku'));
  await writeFile(install.fixture, `${JSON.stringify(payload, null, 2)}\n`);

  await runOffline(configureOptions(install, ['--clients', 'claude']));
  const settings = JSON.parse(
    await readFile(path.join(install.home, '.claude', 'settings.json'), 'utf8'),
  );
  assert.equal(
    settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    'claude-sonnet-4-20260101',
  );
});

test('dry-run emits a safe plan and writes no client, cache, state, directory, or backup', async (t) => {
  const install = await makeInstall(t);
  const options = configureOptions(install, [
    '--clients',
    'claude',
    '--dry-run',
  ]);
  const result = await runOffline(options);

  assert.equal(result.output.dryRun, true);
  assert.equal(result.output.clients[0].configuration, 'generated');
  assert.equal(result.rendered.includes('must-not-be-used'), false);
  assert.equal(await pathExists(path.join(install.home, '.claude')), false);
  assert.equal(await pathExists(path.join(install.root, 'state', 'models.json')), false);
  assert.equal(
    await pathExists(path.join(install.root, 'state', 'client-ownership.json')),
    false,
  );
});

test('a malformed selected client config causes no writes', async (t) => {
  const install = await makeInstall(t);
  const settingsPath = path.join(install.home, '.claude', 'settings.json');
  await mkdir(path.dirname(settingsPath), { recursive: true });
  const malformed = '{ "env": { broken }';
  await writeFile(settingsPath, malformed);

  await assert.rejects(
    runOffline(configureOptions(install, ['--clients', 'claude'])),
    /Invalid JSON/,
  );
  assert.equal(await readFile(settingsPath, 'utf8'), malformed);
  assert.equal(await pathExists(path.join(install.root, 'state', 'models.json')), false);
  assert.equal(
    await pathExists(path.join(install.root, 'state', 'client-ownership.json')),
    false,
  );
  assert.deepEqual(await readdir(path.dirname(settingsPath)), ['settings.json']);
});

test('OpenCode JSONC patch preserves comments, trailing commas, and unrelated settings', async (t) => {
  const install = await makeInstall(t);
  const configPath = path.join(
    install.home,
    '.config',
    'opencode',
    'opencode.jsonc',
  );
  await mkdir(path.dirname(configPath), { recursive: true });
  const original = `\uFEFF{
  // keep this comment
  "plugin": ["existing-plugin"],
  "enabled_providers": ["github-copilot"],
  "permission": {
    "bash": "ask",
  },
}
`;
  await writeFile(configPath, original);

  await runOffline(configureOptions(install, ['--clients', 'opencode', '--set-default']));
  const configuredText = await readFile(configPath, 'utf8');
  const configured = parseJsoncObject(configuredText, configPath);
  assert.equal(configuredText.startsWith('\uFEFF'), true);
  assert.match(configuredText, /\/\/ keep this comment/);
  assert.match(configuredText, /"bash": "ask",\r?\n\s*}/);
  assert.deepEqual(configured.plugin, ['existing-plugin']);
  assert.equal(configured.permission.bash, 'ask');
  assert.deepEqual(
    configured.enabled_providers,
    ['github-copilot', ANTHROPIC_PROVIDER_ID],
  );
  assert.equal(
    configured.provider[ANTHROPIC_PROVIDER_ID].npm,
    '@ai-sdk/anthropic',
  );
  assert.equal(
    configured.provider[ANTHROPIC_PROVIDER_ID].options.baseURL,
    'http://127.0.0.1:4141/v1',
  );
  assert.equal(
    configured.provider[ANTHROPIC_PROVIDER_ID].options.apiKey,
    '{env:COPILOT_HARNESS_GATEWAY_API_KEY}',
  );
  assert.deepEqual(
    configured.provider[ANTHROPIC_PROVIDER_ID].models['gpt-5-mini'],
    { name: 'gpt-5-mini', tool_call: true },
  );
  assert.equal(
    configured.model,
    `${ANTHROPIC_PROVIDER_ID}/claude-sonnet-4-20260101`,
  );
});

test('OpenCode allowlist removal preserves provider entries added later by the user', async (t) => {
  const install = await makeInstall(t);
  const configPath = path.join(install.home, '.config', 'opencode', 'opencode.json');
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify({ enabled_providers: ['github-copilot'] }, null, 2)}\n`,
  );

  await runOffline(configureOptions(install, ['--clients', 'opencode']));
  const edited = JSON.parse(await readFile(configPath, 'utf8'));
  edited.enabled_providers.push('user-added-provider');
  await writeFile(configPath, `${JSON.stringify(edited, null, 2)}\n`);

  const removed = await runOffline(removeOptions(install, ['--clients', 'opencode']));
  const final = JSON.parse(await readFile(configPath, 'utf8'));
  assert.deepEqual(
    final.enabled_providers,
    ['github-copilot', 'user-added-provider'],
  );
  assert.equal(Object.hasOwn(final.provider ?? {}, ANTHROPIC_PROVIDER_ID), false);
  assert.deepEqual(removed.output.clients[0].files[0].conflicts ?? [], []);
});

test('OpenCode refuses dual-file provider ambiguity before writing anything', async (t) => {
  const install = await makeInstall(t);
  const directory = path.join(install.home, '.config', 'opencode');
  const jsonPath = path.join(directory, 'opencode.json');
  const jsoncPath = path.join(directory, 'opencode.jsonc');
  await mkdir(directory, { recursive: true });
  const lower = `${JSON.stringify({
    provider: {
      [ANTHROPIC_PROVIDER_ID]: {
        npm: 'some-existing-provider',
      },
    },
  }, null, 2)}\n`;
  const higher = '{\n  // higher priority\n  "plugin": []\n}\n';
  await writeFile(jsonPath, lower);
  await writeFile(jsoncPath, higher);

  await assert.rejects(
    runOffline(configureOptions(install, ['--clients', 'opencode'])),
    /ambiguous multi-file/,
  );
  assert.equal(await readFile(jsonPath, 'utf8'), lower);
  assert.equal(await readFile(jsoncPath, 'utf8'), higher);
  assert.equal(await pathExists(path.join(install.root, 'state', 'models.json')), false);
});

test('Codex markers preserve bytes, are idempotent, and never overwrite existing top-level defaults', () => {
  const original = [
    '# user preface',
    'approval_policy = "on-request"',
    '',
    '[features]',
    'web_search = true',
    '',
  ].join('\r\n');
  const first = mergeCodexConfig(original, {
    baseUrl: 'http://127.0.0.1:4141',
    setDefault: false,
  });
  assert.equal(first.text.startsWith(original), true);
  assert.equal(first.text.includes(CODEX_PROVIDER_BEGIN), true);
  assert.equal(first.text.includes(CODEX_DEFAULTS_BEGIN), false);

  const second = mergeCodexConfig(first.text, {
    baseUrl: 'http://127.0.0.1:4141',
    setDefault: false,
  });
  assert.equal(second.text, first.text);

  const emptyWithDefaults = mergeCodexConfig('', {
    baseUrl: 'http://127.0.0.1:4141',
    model: 'gpt-5.2-codex',
    setDefault: true,
  });
  const emptyRerun = mergeCodexConfig(emptyWithDefaults.text, {
    baseUrl: 'http://127.0.0.1:4141',
    model: 'gpt-5.2-codex',
    setDefault: true,
    previousBlocks: emptyWithDefaults.managedBlocks,
  });
  assert.equal(emptyRerun.text, emptyWithDefaults.text);
  assert.equal(
    emptyWithDefaults.text.indexOf(CODEX_DEFAULTS_BEGIN)
      < emptyWithDefaults.text.indexOf(CODEX_PROVIDER_BEGIN),
    true,
  );

  const withUserDefaults = [
    'model = "user-model"',
    'model_provider = "user-provider"',
    '',
    '[features]',
    'web_search = true',
    '',
  ].join('\n');
  const preserved = mergeCodexConfig(withUserDefaults, {
    baseUrl: 'http://127.0.0.1:4141',
    model: 'gpt-5.2-codex',
    setDefault: true,
  });
  assert.equal(preserved.text.startsWith(withUserDefaults), true);
  assert.equal(preserved.text.includes('model = "user-model"'), true);
  assert.equal(preserved.text.includes(CODEX_DEFAULTS_BEGIN), false);
  assert.equal(preserved.defaultSkipped, true);
});

test('Codex refuses an unmarked gateway provider table unless forced', () => {
  const text = [
    '[model_providers.copilot_harness_gateway]',
    'name = "User definition"',
    '',
    '[features]',
    'web_search = true',
    '',
  ].join('\n');
  assert.throws(
    () => mergeCodexConfig(text, {
      baseUrl: 'http://127.0.0.1:4141',
      setDefault: false,
    }),
    /unmarked/,
  );
  const forced = mergeCodexConfig(text, {
    baseUrl: 'http://127.0.0.1:4141',
    setDefault: false,
    force: true,
  });
  assert.equal(forced.text.includes(CODEX_PROVIDER_BEGIN), true);
  assert.equal(forced.text.includes('[features]\nweb_search = true'), true);
});

test('Codex refuses malformed TOML before adding a provider', () => {
  assert.throws(
    () => mergeCodexConfig('model = [\n', {
      baseUrl: 'http://127.0.0.1:4141',
      setDefault: false,
      filePath: 'config.toml',
    }),
    /Invalid TOML/,
  );
});

test('OpenCode updates an existing legacy config.json without creating a competing file', async (t) => {
  const install = await makeInstall(t);
  const directory = path.join(install.home, '.config', 'opencode');
  const configPath = path.join(directory, 'config.json');
  await mkdir(directory, { recursive: true });
  await writeFile(configPath, '{\n  "plugin": ["legacy"]\n}\n');

  await runOffline(configureOptions(install, ['--clients', 'opencode']));
  const configured = JSON.parse(await readFile(configPath, 'utf8'));
  assert.deepEqual(configured.plugin, ['legacy']);
  assert.equal(
    configured.provider[ANTHROPIC_PROVIDER_ID].name,
    'Copilot Harness Gateway (Anthropic Messages)',
  );
  assert.equal(
    await pathExists(path.join(directory, 'opencode.jsonc')),
    false,
  );
});

test('OpenCode honors an explicit OPENCODE_CONFIG file even when a sibling JSONC exists', async (t) => {
  const install = await makeInstall(t);
  const directory = path.join(install.home, 'explicit-opencode');
  const explicit = path.join(directory, 'custom.json');
  const sibling = path.join(directory, 'custom.jsonc');
  await mkdir(directory, { recursive: true });
  await writeFile(explicit, '{\n  "plugin": ["explicit"]\n}\n');
  await writeFile(sibling, '{\n  // unrelated sibling\n  "plugin": ["sibling"]\n}\n');
  const options = parseConfigureClientsArgs([
    '--root',
    install.root,
    '--clients',
    'opencode',
    '--models-file',
    install.fixture,
  ]);

  await runOffline(options, {
    env: {
      USERPROFILE: install.home,
      OPENCODE_CONFIG: explicit,
      PATH: '',
    },
  });
  const configured = JSON.parse(await readFile(explicit, 'utf8'));
  assert.equal(
    configured.provider[ANTHROPIC_PROVIDER_ID].npm,
    '@ai-sdk/anthropic',
  );
  assert.match(await readFile(sibling, 'utf8'), /unrelated sibling/);
  assert.doesNotMatch(
    await readFile(sibling, 'utf8'),
    /copilot-harness-anthropic/,
  );
});

test('Codex configure/remove restores the exact preexisting bytes, including an empty-table layout', async (t) => {
  const install = await makeInstall(t);
  const configPath = path.join(install.home, '.codex', 'config.toml');
  await mkdir(path.dirname(configPath), { recursive: true });
  const original = `\uFEFF${[
    '# user-owned bytes',
    'approval_policy = "on-request"',
    '',
    '[features]',
    'web_search = true',
  ].join('\r\n')}`;
  await writeFile(configPath, original);

  await runOffline(configureOptions(install, [
    '--clients',
    'codex',
    '--set-default',
  ]));
  const configured = await readFile(configPath, 'utf8');
  assert.equal(configured.includes(CODEX_PROVIDER_BEGIN), true);
  assert.equal(configured.includes(CODEX_DEFAULTS_BEGIN), true);

  await runOffline(removeOptions(install, ['--clients', 'codex']));
  assert.equal(await readFile(configPath, 'utf8'), original);
});

test('Pi merges the provider and optional defaults without disturbing other providers/settings', async (t) => {
  const install = await makeInstall(t);
  const piDirectory = path.join(install.home, '.pi', 'agent');
  const modelsPath = path.join(piDirectory, 'models.json');
  const settingsPath = path.join(piDirectory, 'settings.json');
  await mkdir(piDirectory, { recursive: true });
  await writeFile(
    modelsPath,
    `${JSON.stringify({
      providers: {
        existing: {
          baseUrl: 'https://example.invalid',
          models: [{ id: 'existing-model', custom: true }],
        },
      },
      keep: true,
    }, null, 2)}\n`,
  );
  await writeFile(
    settingsPath,
    `${JSON.stringify({
      theme: 'dark',
      defaultProvider: 'existing',
      defaultModel: 'existing-model',
    }, null, 2)}\n`,
  );

  await runOffline(configureOptions(install, [
    '--clients',
    'pi',
    '--set-default',
  ]));
  const models = JSON.parse(await readFile(modelsPath, 'utf8'));
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal(models.keep, true);
  assert.equal(models.providers.existing.models[0].custom, true);
  assert.deepEqual(models.providers[ANTHROPIC_PROVIDER_ID], {
    baseUrl: 'http://127.0.0.1:4141',
    api: 'anthropic-messages',
    apiKey: '$COPILOT_HARNESS_GATEWAY_API_KEY',
    models: [
      { id: 'claude-haiku-3.5' },
      { id: 'claude-opus-5' },
      { id: 'claude-sonnet-4-20260101' },
      { id: 'gpt-5-mini' },
      { id: 'gpt-5.2-codex' },
    ],
  });
  assert.equal(settings.theme, 'dark');
  assert.equal(settings.defaultProvider, ANTHROPIC_PROVIDER_ID);
  assert.equal(settings.defaultModel, 'claude-sonnet-4-20260101');
});

test('remove restores unchanged owned values and preserves later managed and unrelated user edits', async (t) => {
  const install = await makeInstall(t);
  const settingsPath = path.join(install.home, '.claude', 'settings.json');
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(
    settingsPath,
    `${JSON.stringify({
      theme: 'dark',
      model: 'user-default',
      env: {
        KEEP_ME: 'yes',
        ANTHROPIC_BASE_URL: 'http://original-base',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'legacy-sonnet',
      },
    }, null, 2)}\n`,
  );

  await runOffline(configureOptions(install, [
    '--clients',
    'claude',
    '--set-default',
  ]));
  const userEdited = JSON.parse(await readFile(settingsPath, 'utf8'));
  userEdited.theme = 'light';
  userEdited.env.ANTHROPIC_BASE_URL = 'http://user-edited-base';
  await writeFile(settingsPath, `${JSON.stringify(userEdited, null, 2)}\n`);

  const removed = await runOffline(removeOptions(install, ['--clients', 'claude']));
  const final = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal(final.theme, 'light');
  assert.equal(final.model, 'user-default');
  assert.equal(final.env.KEEP_ME, 'yes');
  assert.equal(final.env.ANTHROPIC_BASE_URL, 'http://user-edited-base');
  assert.equal(final.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'legacy-sonnet');
  assert.equal(Object.hasOwn(final, 'apiKeyHelper'), false);
  assert.equal(Object.hasOwn(final.env, 'ANTHROPIC_DEFAULT_OPUS_MODEL'), false);
  assert.equal(Object.hasOwn(final.env, 'ANTHROPIC_DEFAULT_HAIKU_MODEL'), false);
  assert.equal(
    removed.output.clients[0].files[0].conflicts.some((message) =>
      message.includes('ANTHROPIC_BASE_URL')),
    true,
  );

  const ownership = JSON.parse(
    await readFile(path.join(install.root, 'state', 'client-ownership.json'), 'utf8'),
  );
  assert.equal(ownership.clients.claude.files[0].ownedPaths.length, 1);
  assert.deepEqual(
    ownership.clients.claude.files[0].ownedPaths[0].path,
    ['env', 'ANTHROPIC_BASE_URL'],
  );
});

test('remove deletes a tool-created byte-identical config but first creates an adjacent backup', async (t) => {
  const install = await makeInstall(t);
  const settingsPath = path.join(install.home, '.claude', 'settings.json');
  await runOffline(configureOptions(install, ['--clients', 'claude']));
  assert.equal(await pathExists(settingsPath), true);

  await runOffline(removeOptions(install, ['--clients', 'claude']));
  assert.equal(await pathExists(settingsPath), false);
  const directory = await readdir(path.dirname(settingsPath));
  assert.equal(
    directory.filter((name) => name.startsWith('settings.json.backup-')).length,
    1,
  );
});

test('all absent clients configure idempotently without executables and remove cleanly', async (t) => {
  const install = await makeInstall(t);
  const options = configureOptions(install, ['--clients', 'all', '--set-default']);
  const first = await runOffline(options);
  assert.deepEqual(
    first.output.clients.map((client) => client.installation),
    ['not-installed', 'not-installed', 'not-installed', 'not-installed'],
  );

  await runOffline(options);
  const paths = resolveClientPaths({ home: install.home, env: {} });
  const generated = [
    paths.claude.settings,
    paths.codex.config,
    paths.opencode.jsonc,
    paths.pi.models,
    paths.pi.settings,
  ];
  for (const filePath of generated) {
    assert.equal(await pathExists(filePath), true, filePath);
  }

  await runOffline(removeOptions(install, ['--clients', 'all']));
  for (const filePath of generated) {
    assert.equal(await pathExists(filePath), false, filePath);
  }
  const ownership = JSON.parse(
    await readFile(path.join(install.root, 'state', 'client-ownership.json'), 'utf8'),
  );
  assert.deepEqual(ownership.clients, {});
});

test('--home ignores ambient client path override variables', () => {
  const home = path.resolve('test-home');
  const paths = resolveClientPaths({
    home,
    env: {
      USERPROFILE: path.resolve('ambient-home'),
      CODEX_HOME: path.resolve('ambient-codex'),
      OPENCODE_CONFIG: path.resolve('ambient-opencode.jsonc'),
      PI_CODING_AGENT_DIR: path.resolve('ambient-pi'),
    },
  });
  assert.equal(paths.codex.config, path.join(home, '.codex', 'config.toml'));
  assert.equal(
    paths.opencode.jsonc,
    path.join(home, '.config', 'opencode', 'opencode.jsonc'),
  );
  assert.equal(paths.pi.models, path.join(home, '.pi', 'agent', 'models.json'));
});

test('configure CLI parsing is strict', () => {
  assert.throws(() => parseConfigureClientsArgs([]), /--root is required/);
  assert.throws(
    () => parseConfigureClientsArgs(['--root', '.', '--clients', 'claude,bogus']),
    /Unknown client/,
  );
  assert.throws(
    () => parseConfigureClientsArgs(['--root', '.', '--clients', 'all,claude']),
    /cannot be combined/,
  );
  assert.throws(
    () => parseConfigureClientsArgs(['--root', '.', '--remove', '--model', 'gpt-5']),
    /cannot be combined/,
  );
  assert.throws(
    () => parseConfigureClientsArgs(['--root', '.', '--timeout-ms', '999999']),
    /100 through 120000/,
  );
});
