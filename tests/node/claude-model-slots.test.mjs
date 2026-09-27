import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mergeClaudeSettings,
  parseConfigureClientsArgs,
} from '../../runtime/configure-clients.mjs';

const BASE = 'http://127.0.0.1:4141';

test('sonnet and opus slots can be pinned to different models', () => {
  // Claude Code picks a model per slot, so collapsing both onto one value
  // removes the user's ability to switch between them.
  const merged = mergeClaudeSettings({}, {
    baseUrl: BASE,
    claudeModel: 'claude-opus-5-5',
    sonnetModel: 'claude-sonnet-5',
    opusModel: 'claude-opus-5-5',
    fastModel: 'claude-sonnet-5',
  });

  assert.equal(merged.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-sonnet-5');
  assert.equal(merged.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-opus-5-5');
  assert.equal(merged.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'claude-sonnet-5');
});

test('the new model flags are parsed', () => {
  const parsed = parseConfigureClientsArgs([
    '--root', 'C:\\root',
    '--sonnet-model', 'claude-sonnet-5',
    '--opus-model', 'claude-opus-5-5',
    '--fast-model', 'claude-sonnet-5',
  ]);

  assert.equal(parsed.sonnetModel, 'claude-sonnet-5');
  assert.equal(parsed.opusModel, 'claude-opus-5-5');
  assert.equal(parsed.fastModel, 'claude-sonnet-5');
});

test('omitting the new flags leaves them undefined so defaults still apply', () => {
  const parsed = parseConfigureClientsArgs(['--root', 'C:\\root']);

  assert.equal(parsed.sonnetModel, undefined);
  assert.equal(parsed.opusModel, undefined);
});

test('a claude model with no slot overrides still fills both slots', () => {
  // Pinning one model remains the simple case and must keep working.
  const merged = mergeClaudeSettings({}, {
    baseUrl: BASE,
    claudeModel: 'claude-opus-5-5',
    fastModel: 'claude-sonnet-5',
  });

  assert.equal(merged.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-opus-5-5');
  assert.equal(merged.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-opus-5-5');
});
