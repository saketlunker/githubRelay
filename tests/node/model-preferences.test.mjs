import assert from 'node:assert/strict';
import test from 'node:test';

import { parse as parseToml } from 'smol-toml';

import {
  CODEX_PROVIDER_BEGIN,
  CODEX_PROVIDER_END,
  effortForModel,
  mergeClaudeSettings,
  mergeClientPreferences,
  mergeCodexConfig,
  parseConfigureClientsArgs,
  selectClientModels,
} from '../../runtime/configure-clients.mjs';

const BASE = 'http://127.0.0.1:4141';
const ALL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function model(id, efforts) {
  return efforts === undefined
    ? { id }
    : { id, capabilities: { supports: { reasoning_effort: efforts } } };
}

// Shaped like the account catalog this relay was built against.
function catalog(models) {
  return {
    models,
    aliases: {
      default: 'claude-sonnet-5',
      claude: 'claude-sonnet-5',
      codex: 'gpt-5.3-codex',
      fast: 'claude-haiku-4-5',
    },
  };
}

const FULL = catalog([
  model('claude-haiku-4-5', []),
  model('claude-sonnet-5', ALL_EFFORTS),
  model('claude-opus-5', ALL_EFFORTS),
  model('claude-opus-5-5', ALL_EFFORTS),
  model('gpt-5.3-codex', ['low', 'medium', 'high', 'xhigh']),
  model('gpt-6-astra', ALL_EFFORTS),
  model('gpt-6-sol', ALL_EFFORTS),
]);

test('defaults are Opus 5.5 at xhigh for Claude Code and GPT-6 Astra at max for Codex', () => {
  const selected = selectClientModels(FULL, {});

  assert.equal(selected.claudeModel, 'claude-opus-5-5');
  assert.equal(selected.opusModel, 'claude-opus-5-5');
  assert.equal(selected.sonnetModel, 'claude-sonnet-5');
  assert.equal(selected.codexModel, 'gpt-6-astra', 'astra is preferred over the newer-sorting sol');
  assert.equal(selected.claudeEffort, 'xhigh');
  assert.deepEqual(selected.claudeModelEfforts, {
    'claude-opus-5-5': 'xhigh',
    'claude-sonnet-5': 'xhigh',
  });
  assert.equal(selected.codexEffort, 'max');
});

test('each Claude model gets its own level, capped where settings cannot hold it', () => {
  const selected = selectClientModels(catalog([
    model('claude-haiku-4-5', []),
    model('claude-sonnet-5', ['low', 'medium', 'high']),
    model('claude-opus-5-5', ALL_EFFORTS),
    model('gpt-6-astra', ALL_EFFORTS),
  ]), { claudeEffort: 'max' });

  assert.equal(selected.claudeEffort, 'max', 'max is kept for the environment variable');
  assert.deepEqual(selected.claudeModelEfforts, {
    'claude-opus-5-5': 'xhigh',
    'claude-sonnet-5': 'high',
  });
});

test('an account without the preferred models falls back instead of failing', () => {
  const selected = selectClientModels(catalog([
    model('claude-haiku-4-5', []),
    model('claude-sonnet-5', ALL_EFFORTS),
    model('claude-opus-5', ALL_EFFORTS),
    model('gpt-5.3-codex', ['low', 'medium', 'high', 'xhigh']),
  ]), {});

  assert.equal(selected.claudeModel, 'claude-opus-5');
  assert.equal(selected.codexModel, 'gpt-5.3-codex');
  assert.equal(
    selected.codexEffort,
    'xhigh',
    'max would be rejected upstream by a model that stops at xhigh',
  );
});

test('effort is clamped to the strongest level a model advertises', () => {
  assert.equal(effortForModel('max', model('m', ALL_EFFORTS)), 'max');
  assert.equal(effortForModel('max', model('m', ['low', 'high'])), 'high');
  assert.equal(effortForModel('medium', model('m', ['high'])), undefined);
  assert.equal(effortForModel('max', model('m', [])), undefined, 'no effort for a model without reasoning');
  assert.equal(effortForModel('max', model('m')), 'max', 'missing capability data is trusted');
  assert.equal(effortForModel('default', model('m', ALL_EFFORTS)), undefined);
  assert.equal(effortForModel(undefined, model('m', ALL_EFFORTS)), undefined);
});

test('saved choices apply on the next run and a missing saved model falls back', () => {
  const saved = mergeClientPreferences({}, {
    opusModel: 'claude-opus-5',
    codexModel: 'gpt-6-sol',
    claudeEffort: 'high',
  });
  const selected = selectClientModels(FULL, {}, saved);
  assert.equal(selected.opusModel, 'claude-opus-5');
  assert.equal(selected.codexModel, 'gpt-6-sol');
  assert.equal(selected.claudeEffort, 'high');

  const gone = selectClientModels(FULL, {}, { codexModel: 'gpt-retired' });
  assert.equal(gone.codexModel, 'gpt-6-astra');
});

test('an explicit flag beats a saved choice, and only given flags are saved', () => {
  const saved = { codexModel: 'gpt-6-sol', codexEffort: 'high' };
  const selected = selectClientModels(FULL, { codexModel: 'gpt-6-astra' }, saved);
  assert.equal(selected.codexModel, 'gpt-6-astra');
  assert.equal(selected.codexEffort, 'high');

  assert.deepEqual(
    mergeClientPreferences(saved, { codexModel: 'gpt-6-astra' }),
    { codexModel: 'gpt-6-astra', codexEffort: 'high' },
  );
});

test('effort flags are validated', () => {
  const parsed = parseConfigureClientsArgs(['--root', 'C:\\r', '--claude-effort', 'max', '--codex-effort', 'default']);
  assert.equal(parsed.claudeEffort, 'max');
  assert.equal(parsed.codexEffort, 'default');
  assert.throws(
    () => parseConfigureClientsArgs(['--root', 'C:\\r', '--claude-effort', 'ultra']),
    /must be one of/,
  );
});

test('Claude Code gets xhigh per model and max through the environment variable', () => {
  const xhigh = mergeClaudeSettings({}, {
    baseUrl: BASE,
    claudeModel: 'claude-opus-5-5',
    fastModel: 'claude-sonnet-5',
    effort: 'xhigh',
    modelEfforts: { 'claude-opus-5-5': 'xhigh', 'claude-sonnet-5': 'xhigh' },
  });
  // Where Claude Code's own /effort saves a choice; a top-level effortLevel
  // is ignored for Opus 5.5.
  assert.deepEqual(xhigh.modelSettings, {
    'claude-opus-5-5': { effortLevel: 'xhigh' },
    'claude-sonnet-5': { effortLevel: 'xhigh' },
  });
  assert.equal(xhigh.effortLevel, undefined);
  assert.equal(xhigh.env.CLAUDE_CODE_EFFORT_LEVEL, undefined, 'the variable would lock out /effort');

  const max = mergeClaudeSettings({}, {
    baseUrl: BASE,
    claudeModel: 'claude-opus-5-5',
    fastModel: 'claude-sonnet-5',
    effort: 'max',
  });
  assert.equal(max.env.CLAUDE_CODE_EFFORT_LEVEL, 'max');
  assert.equal(max.modelSettings, undefined, 'settings.json silently drops max');

  const unpinned = mergeClaudeSettings({}, { baseUrl: BASE, claudeModel: 'claude-opus-5-5', fastModel: 'claude-sonnet-5' });
  assert.equal(unpinned.env.CLAUDE_CODE_EFFORT_LEVEL, undefined);
  assert.equal(unpinned.modelSettings, undefined);
});

test('a fresh Codex config gets the model and its effort', () => {
  const merged = mergeCodexConfig('', {
    baseUrl: BASE,
    model: 'gpt-6-astra',
    reasoningEffort: 'max',
    setDefault: true,
  });
  const parsed = parseToml(merged.text);
  assert.equal(parsed.model, 'gpt-6-astra');
  assert.equal(parsed.model_reasoning_effort, 'max');
  assert.equal(parsed.model_providers.copilot_harness_gateway.base_url, `${BASE}/v1`);
});

// The layout the Codex desktop app actually left on disk: its keys and
// tables inside the gateway's markers, with the end marker pushed to the end.
function desktopAppRewrite() {
  const previous = mergeCodexConfig('', {
    baseUrl: BASE,
    model: 'gpt-5.3-codex',
    setDefault: true,
  });
  const defaults = previous.managedBlocks.find((block) => block.name === 'defaults').appliedText;
  const provider = previous.managedBlocks.find((block) => block.name === 'provider').appliedText;
  const table = provider.split('\n').slice(1, -1).join('\n');
  const text = [
    defaults,
    '',
    CODEX_PROVIDER_BEGIN,
    'notify = [ "C:\\\\tools\\\\notify.exe", "turn-ended" ]',
    'model_reasoning_effort = "high"',
    table,
    '',
    '[desktop]',
    'sansFontSize = 14',
    '',
    '[windows]',
    'sandbox = "elevated"',
    '',
    '[mcp_servers.node_repl]',
    'command = "C:\\\\tools\\\\node_repl.exe"',
    CODEX_PROVIDER_END,
    '',
  ].join('\n');
  return { text, previousBlocks: previous.managedBlocks };
}

test('another tool rewriting config.toml around the markers is survived, not destroyed', () => {
  const { text, previousBlocks } = desktopAppRewrite();
  const before = parseToml(text);

  const merged = mergeCodexConfig(text, {
    baseUrl: BASE,
    model: 'gpt-6-astra',
    reasoningEffort: 'max',
    setDefault: true,
    previousBlocks,
  });
  const after = parseToml(merged.text);

  assert.deepEqual(after.desktop, before.desktop, "the app's own tables are kept");
  assert.deepEqual(after.windows, before.windows);
  assert.deepEqual(after.mcp_servers, before.mcp_servers);
  assert.deepEqual(after.notify, before.notify);
  assert.equal(after.model, 'gpt-6-astra');
  assert.equal(
    after.model_reasoning_effort,
    'high',
    "an effort set by another tool is left alone instead of duplicated",
  );

  const inside = merged.text.slice(
    merged.text.indexOf(CODEX_PROVIDER_BEGIN),
    merged.text.indexOf(CODEX_PROVIDER_END),
  );
  assert.doesNotMatch(inside, /\[desktop\]/, 'the markers now wrap only the gateway table');

  const again = mergeCodexConfig(merged.text, {
    baseUrl: BASE,
    model: 'gpt-6-astra',
    reasoningEffort: 'max',
    setDefault: true,
    previousBlocks: merged.managedBlocks,
  });
  assert.equal(again.text, merged.text, 'a second run changes nothing');
});

test('an edit to the gateway table itself still needs --force', () => {
  const { text, previousBlocks } = desktopAppRewrite();
  const edited = text.replace(`base_url = "${BASE}/v1"`, 'base_url = "http://127.0.0.1:9999/v1"');

  assert.throws(
    () => mergeCodexConfig(edited, {
      baseUrl: BASE,
      model: 'gpt-6-astra',
      setDefault: true,
      previousBlocks,
    }),
    /user-modified Codex provider block/,
  );
});
