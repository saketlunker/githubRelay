import { constants as fsConstants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  applyEdits,
  modify as modifyJsonc,
  parse as parseJsonc,
  printParseErrorCode,
} from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';

import {
  atomicRemoveFile,
  atomicWriteFile,
  atomicWriteJson,
  serializeJson,
  sha256Hex,
} from './lib/atomic-files.mjs';
import {
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  canonicalJson,
  compareModelIds,
  loadModelCatalog,
  normalizeDiscoveryTimeout,
  validateModelId,
  writeModelCache,
} from './lib/model-catalog.mjs';

export const CLIENT_NAMES = Object.freeze(['claude', 'codex', 'opencode', 'pi']);
export const CLIENT_API_KEY_ENV = 'COPILOT_HARNESS_GATEWAY_API_KEY';
export const ANTHROPIC_PROVIDER_ID = 'copilot-harness-anthropic';
export const CODEX_PROVIDER_ID = 'copilot_harness_gateway';
export const CLAUDE_API_KEY_HELPER =
  'powershell.exe -NoLogo -NoProfile -NonInteractive -Command "[Console]::Out.Write($env:COPILOT_HARNESS_GATEWAY_API_KEY)"';

export function claudeApiKeyHelper(platform = process.platform) {
  return platform === 'win32'
    ? CLAUDE_API_KEY_HELPER
    : '/bin/sh -c \'printf %s "$COPILOT_HARNESS_GATEWAY_API_KEY"\'';
}

export const CODEX_PROVIDER_BEGIN = '# >>> copilot-harness-gateway:provider >>>';
export const CODEX_PROVIDER_END = '# <<< copilot-harness-gateway:provider <<<';
export const CODEX_DEFAULTS_BEGIN = '# >>> copilot-harness-gateway:defaults >>>';
export const CODEX_DEFAULTS_END = '# <<< copilot-harness-gateway:defaults <<<';

export const EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
// Claude runs at xhigh, the strongest level Claude Code can save in its
// settings, so /effort still works inside a session. GPT runs at max.
export const DEFAULT_EFFORTS = Object.freeze({ claude: 'xhigh', codex: 'max' });
const CLAUDE_EFFORT_ENV = 'CLAUDE_CODE_EFFORT_LEVEL';
// Claude Code's settings schema stops here and silently drops anything higher.
const CLAUDE_SETTINGS_EFFORT_CEILING = 'xhigh';

// What this relay is for: the strongest Claude model in Claude Code and the
// strongest GPT model in Codex. Each list is tried in order and the first
// model the account can see wins, so an account without one falls back to
// the newest model of the same family instead of failing.
export const PREFERRED_MODELS = Object.freeze({
  opus: Object.freeze(['claude-opus-5-5']),
  sonnet: Object.freeze(['claude-sonnet-5']),
  codex: Object.freeze(['gpt-6-astra']),
});

// Choices that persist, so re-linking agents later keeps what the user picked.
const PREFERENCE_KEYS = Object.freeze([
  'claudeModel',
  'sonnetModel',
  'opusModel',
  'fastModel',
  'codexModel',
  'claudeEffort',
  'codexEffort',
]);

const OWNERSHIP_SCHEMA_VERSION = 1;
const VALUE_OPTIONS = new Map([
  ['--root', 'root'],
  ['--clients', 'clients'],
  ['--home', 'home'],
  ['--model', 'model'],
  ['--claude-model', 'claudeModel'],
  ['--sonnet-model', 'sonnetModel'],
  ['--opus-model', 'opusModel'],
  ['--codex-model', 'codexModel'],
  ['--fast-model', 'fastModel'],
  ['--claude-effort', 'claudeEffort'],
  ['--codex-effort', 'codexEffort'],
  ['--models-file', 'modelsFile'],
  ['--timeout-ms', 'timeoutMs'],
]);
const BOOLEAN_OPTIONS = new Map([
  ['--set-default', 'setDefault'],
  ['--dry-run', 'dryRun'],
  ['--remove', 'remove'],
  ['--force', 'force'],
]);
const EXECUTABLE_NAMES = Object.freeze({
  claude: 'claude',
  codex: 'codex',
  opencode: 'opencode',
  pi: 'pi',
});

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function splitLongOption(argument) {
  const separator = argument.indexOf('=');
  if (separator === -1) {
    return { name: argument, inlineValue: undefined };
  }
  return {
    name: argument.slice(0, separator),
    inlineValue: argument.slice(separator + 1),
  };
}

function readOptionValue(argv, index, name, inlineValue) {
  if (inlineValue !== undefined) {
    if (inlineValue.length === 0) {
      throw new Error(`${name} requires a non-empty value.`);
    }
    return { value: inlineValue, nextIndex: index };
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} requires a value.`);
  }
  return { value, nextIndex: index + 1 };
}

function parseClients(value) {
  const names = value.split(',').map((item) => item.trim());
  if (names.some((item) => item.length === 0)) {
    throw new Error('--clients must be a comma-separated list without empty entries.');
  }
  if (names.includes('all')) {
    if (names.length !== 1) {
      throw new Error('"all" cannot be combined with individual client names.');
    }
    return [...CLIENT_NAMES];
  }

  const result = [];
  for (const name of names) {
    if (!CLIENT_NAMES.includes(name)) {
      throw new Error(`Unknown client "${name}".`);
    }
    if (result.includes(name)) {
      throw new Error(`Client "${name}" may be selected only once.`);
    }
    result.push(name);
  }
  return result;
}

export function parseConfigureClientsArgs(argv) {
  if (!Array.isArray(argv)) {
    throw new TypeError('CLI arguments must be an array.');
  }

  const parsed = {};
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (typeof argument !== 'string' || argument.length === 0) {
      throw new Error('CLI arguments must be non-empty strings.');
    }
    if (!argument.startsWith('--')) {
      throw new Error(`Unexpected positional argument "${argument}".`);
    }

    const { name, inlineValue } = splitLongOption(argument);
    if (seen.has(name)) {
      throw new Error(`Option "${name}" may be specified only once.`);
    }
    seen.add(name);

    const booleanProperty = BOOLEAN_OPTIONS.get(name);
    if (booleanProperty !== undefined) {
      if (inlineValue !== undefined) {
        throw new Error(`${name} does not accept a value.`);
      }
      parsed[booleanProperty] = true;
      continue;
    }

    const valueProperty = VALUE_OPTIONS.get(name);
    if (valueProperty === undefined) {
      throw new Error(`Unknown option "${name}".`);
    }
    const read = readOptionValue(argv, index, name, inlineValue);
    parsed[valueProperty] = read.value;
    index = read.nextIndex;
  }

  if (parsed.root === undefined || parsed.root.trim().length === 0) {
    throw new Error('--root is required.');
  }

  for (const property of ['model', 'claudeModel', 'sonnetModel', 'opusModel', 'codexModel', 'fastModel']) {
    if (parsed[property] !== undefined) {
      validateModelId(parsed[property], `Value for --${property.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
    }
  }
  // "default" leaves effort to the client instead of pinning it.
  const effortChoices = [...EFFORT_LEVELS, 'default'];
  for (const property of ['claudeEffort', 'codexEffort']) {
    if (parsed[property] !== undefined && !effortChoices.includes(parsed[property])) {
      throw new Error(
        `--${property.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} must be one of: ${effortChoices.join(', ')}.`,
      );
    }
  }

  if (
    parsed.remove
    && (
      parsed.model !== undefined
      || parsed.claudeModel !== undefined
      || parsed.sonnetModel !== undefined
      || parsed.opusModel !== undefined
      || parsed.codexModel !== undefined
      || parsed.fastModel !== undefined
      || parsed.claudeEffort !== undefined
      || parsed.codexEffort !== undefined
      || parsed.modelsFile !== undefined
      || parsed.setDefault
    )
  ) {
    throw new Error(
      '--remove cannot be combined with model selection, --models-file, or --set-default.',
    );
  }

  return {
    root: path.resolve(parsed.root),
    clients: parsed.clients === undefined ? [...CLIENT_NAMES] : parseClients(parsed.clients),
    home: parsed.home === undefined ? undefined : path.resolve(parsed.home),
    model: parsed.model,
    claudeModel: parsed.claudeModel,
    sonnetModel: parsed.sonnetModel,
    opusModel: parsed.opusModel,
    codexModel: parsed.codexModel,
    fastModel: parsed.fastModel,
    claudeEffort: parsed.claudeEffort,
    codexEffort: parsed.codexEffort,
    setDefault: parsed.setDefault === true,
    dryRun: parsed.dryRun === true,
    remove: parsed.remove === true,
    force: parsed.force === true,
    modelsFile: parsed.modelsFile === undefined ? undefined : path.resolve(parsed.modelsFile),
    timeoutMs: parsed.timeoutMs === undefined
      ? DEFAULT_DISCOVERY_TIMEOUT_MS
      : normalizeDiscoveryTimeout(parsed.timeoutMs),
  };
}

function resolveEnvironmentPath(value, base) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(base, value);
}

export function resolveClientPaths({
  home = undefined,
  env = process.env,
  useEnvironmentOverrides = home === undefined,
} = {}) {
  const effectiveHome = home
    ?? env.USERPROFILE
    ?? env.HOME;
  if (typeof effectiveHome !== 'string' || effectiveHome.length === 0) {
    throw new Error('Unable to determine the user home directory.');
  }
  const resolvedHome = path.resolve(effectiveHome);
  const allowOverrides = useEnvironmentOverrides && home === undefined;

  const codexDirectory = allowOverrides && env.CODEX_HOME
    ? resolveEnvironmentPath(env.CODEX_HOME, resolvedHome)
    : path.join(resolvedHome, '.codex');

  let openCodeJson;
  let openCodeJsonc;
  let openCodeConfig;
  let openCodeDirectory;
  let openCodeExplicitTarget = null;
  if (allowOverrides && env.OPENCODE_CONFIG) {
    const configured = resolveEnvironmentPath(env.OPENCODE_CONFIG, resolvedHome);
    const extension = path.extname(configured).toLowerCase();
    if (extension === '.json' || extension === '.jsonc') {
      openCodeDirectory = path.dirname(configured);
      const stem = configured.slice(0, -extension.length);
      openCodeJson = `${stem}.json`;
      openCodeJsonc = `${stem}.jsonc`;
      openCodeConfig = path.join(openCodeDirectory, 'config.json');
      openCodeExplicitTarget = configured;
    } else {
      openCodeDirectory = configured;
      openCodeJson = path.join(configured, 'opencode.json');
      openCodeJsonc = path.join(configured, 'opencode.jsonc');
      openCodeConfig = path.join(configured, 'config.json');
    }
  } else {
    const configBase = allowOverrides && env.XDG_CONFIG_HOME
      ? resolveEnvironmentPath(env.XDG_CONFIG_HOME, resolvedHome)
      : path.join(resolvedHome, '.config');
    openCodeDirectory = path.join(configBase, 'opencode');
    openCodeJson = path.join(openCodeDirectory, 'opencode.json');
    openCodeJsonc = path.join(openCodeDirectory, 'opencode.jsonc');
    openCodeConfig = path.join(openCodeDirectory, 'config.json');
  }

  const piDirectory = allowOverrides && env.PI_CODING_AGENT_DIR
    ? resolveEnvironmentPath(env.PI_CODING_AGENT_DIR, resolvedHome)
    : path.join(resolvedHome, '.pi', 'agent');

  return {
    home: resolvedHome,
    claude: {
      settings: path.join(resolvedHome, '.claude', 'settings.json'),
    },
    codex: {
      config: path.join(codexDirectory, 'config.toml'),
    },
    opencode: {
      directory: openCodeDirectory,
      config: openCodeConfig,
      json: openCodeJson,
      jsonc: openCodeJsonc,
      explicitTarget: openCodeExplicitTarget,
    },
    pi: {
      directory: piDirectory,
      models: path.join(piDirectory, 'models.json'),
      settings: path.join(piDirectory, 'settings.json'),
    },
  };
}

function jsonPathKey(jsonPath) {
  return JSON.stringify(jsonPath);
}

function assertSafeJsonPath(jsonPath) {
  if (
    !Array.isArray(jsonPath)
    || jsonPath.length === 0
    || jsonPath.some((segment) =>
      typeof segment !== 'string'
      || ['__proto__', 'prototype', 'constructor'].includes(segment))
  ) {
    throw new Error('JSON paths must contain safe, non-empty string segments.');
  }
}

export function getJsonPathState(root, jsonPath) {
  assertSafeJsonPath(jsonPath);
  let current = root;
  for (const segment of jsonPath) {
    if (
      !isPlainObject(current)
      || !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      return { present: false };
    }
    current = current[segment];
  }
  return { present: true, value: current };
}

export function setJsonPath(root, jsonPath, value) {
  assertSafeJsonPath(jsonPath);
  let current = root;
  for (let index = 0; index < jsonPath.length - 1; index += 1) {
    const segment = jsonPath[index];
    if (!isPlainObject(current[segment])) {
      current[segment] = {};
    }
    current = current[segment];
  }
  current[jsonPath.at(-1)] = cloneJson(value);
}

export function deleteJsonPath(root, jsonPath) {
  assertSafeJsonPath(jsonPath);
  let current = root;
  for (let index = 0; index < jsonPath.length - 1; index += 1) {
    const segment = jsonPath[index];
    if (!isPlainObject(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return false;
    }
    current = current[segment];
  }
  if (!isPlainObject(current) || !Object.prototype.hasOwnProperty.call(current, jsonPath.at(-1))) {
    return false;
  }
  delete current[jsonPath.at(-1)];
  return true;
}

function valuesEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function parseStrictJsonObject(text, filePath) {
  let value;
  try {
    value = JSON.parse(text.startsWith('\uFEFF') ? text.slice(1) : text);
  } catch (error) {
    throw new Error(`Invalid JSON in "${filePath}".`, { cause: error });
  }
  if (!isPlainObject(value)) {
    throw new Error(`"${filePath}" must contain a JSON object.`);
  }
  return value;
}

export function parseJsoncObject(text, filePath = 'JSONC input', { strict = false } = {}) {
  const parseText = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const errors = [];
  const value = parseJsonc(parseText, errors, {
    allowTrailingComma: !strict,
    disallowComments: strict,
  });
  if (errors.length > 0) {
    const first = errors[0];
    throw new Error(
      `Invalid ${strict ? 'JSON' : 'JSONC'} in "${filePath}" at offset ${first.offset + (parseText === text ? 0 : 1)}: ${printParseErrorCode(first.error)}.`,
    );
  }
  if (!isPlainObject(value)) {
    throw new Error(`"${filePath}" must contain a JSON object.`);
  }
  return value;
}

function detectTextStyle(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const indentMatch = text.match(/(?:^|\r?\n)([ \t]+)"/);
  let indent = 2;
  if (indentMatch) {
    indent = indentMatch[1].includes('\t') ? '\t' : indentMatch[1].length;
  }
  return {
    eol,
    indent,
    finalNewline: /\r?\n$/.test(text),
  };
}

function stringifyJsonLike(value, originalText, created) {
  const style = detectTextStyle(originalText ?? '');
  let output = JSON.stringify(value, null, style.indent).replaceAll('\n', style.eol);
  if (created || style.finalNewline) {
    output += style.eol;
  }
  return originalText?.startsWith('\uFEFF') ? `\uFEFF${output}` : output;
}

function jsoncFormattingOptions(text) {
  const style = detectTextStyle(text);
  return {
    insertSpaces: style.indent !== '\t',
    tabSize: typeof style.indent === 'number' ? style.indent : 2,
    eol: style.eol,
  };
}

function applyJsoncChanges(text, changes) {
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  let output = bom.length === 0 ? text : text.slice(1);
  for (const change of changes) {
    const edits = modifyJsonc(output, change.path, change.value, {
      formattingOptions: jsoncFormattingOptions(output),
    });
    output = applyEdits(output, edits);
  }
  return `${bom}${output}`;
}

function pathLabel(jsonPath) {
  return jsonPath.join('.');
}

function makeOwnedPath(pathSegments, original, applied, desired = {}) {
  const originalRecord = { present: original.present };
  if (original.present) {
    originalRecord.value = cloneJson(original.value);
  }
  return {
    path: [...pathSegments],
    original: originalRecord,
    applied: cloneJson(applied),
    ...(desired.mode === 'array-member'
      ? { mode: desired.mode, member: desired.member }
      : {}),
  };
}

function collectCreatedContainers(source, desiredValues) {
  const containers = new Map();
  for (const desired of desiredValues) {
    for (let length = 1; length < desired.path.length; length += 1) {
      const prefix = desired.path.slice(0, length);
      if (!getJsonPathState(source, prefix).present) {
        containers.set(jsonPathKey(prefix), prefix);
      }
    }
  }
  return [...containers.values()];
}

function prepareOwnedJsonChanges({
  source,
  desiredValues,
  releasePaths = [],
  previousEntry,
  force,
  filePath,
}) {
  const priorOwned = new Map(
    (previousEntry?.ownedPaths ?? []).map((entry) => [jsonPathKey(entry.path), entry]),
  );
  const desiredKeys = new Set();
  const nextOwned = [];
  const changes = [];
  let released = false;

  for (const desired of desiredValues) {
    const key = jsonPathKey(desired.path);
    desiredKeys.add(key);
    const current = getJsonPathState(source, desired.path);
    const previous = priorOwned.get(key);
    // "prefer-user": a default the user may override. A value they set, or
    // changed since the gateway wrote it, wins and stops being managed.
    // "replace": the user just asked for this value, so it overwrites theirs.
    if (
      desired.policy === 'prefer-user'
      && current.present
      && (previous === undefined || !valuesEqual(current.value, previous.applied))
    ) {
      continue;
    }
    if (
      desired.policy === undefined
      && previous
      && (
        current.present !== true
        || !valuesEqual(current.value, previous.applied)
      )
      && (
        current.present !== true
        || !valuesEqual(current.value, desired.value)
      )
      && !force
    ) {
      throw new Error(
        `Refusing to replace user-modified managed value "${pathLabel(desired.path)}" in "${filePath}" without --force.`,
      );
    }

    const original = desired.mode === 'array-member'
      ? {
          present: true,
          value: desired.value.filter((item) => item !== desired.member),
        }
      : previous?.original ?? current;
    nextOwned.push(makeOwnedPath(desired.path, original, desired.value, desired));
    if (!current.present || !valuesEqual(current.value, desired.value)) {
      changes.push({ path: desired.path, value: cloneJson(desired.value) });
    }
  }

  // A managed value that is no longer wanted is put back the way it was,
  // unless the user has changed it since, in which case it is theirs.
  for (const releasePath of releasePaths) {
    const key = jsonPathKey(releasePath);
    const previous = priorOwned.get(key);
    if (previous === undefined || desiredKeys.has(key)) {
      continue;
    }
    desiredKeys.add(key);
    const current = getJsonPathState(source, releasePath);
    if (current.present && valuesEqual(current.value, previous.applied)) {
      changes.push({
        path: [...releasePath],
        value: previous.original.present ? cloneJson(previous.original.value) : undefined,
      });
      released = true;
    }
  }

  for (const previous of priorOwned.values()) {
    if (!desiredKeys.has(jsonPathKey(previous.path))) {
      nextOwned.push(cloneJson(previous));
    }
  }

  const priorContainers = previousEntry?.createdContainers ?? [];
  const containers = new Map(
    priorContainers.map((containerPath) => [jsonPathKey(containerPath), [...containerPath]]),
  );
  for (const containerPath of collectCreatedContainers(source, desiredValues)) {
    containers.set(jsonPathKey(containerPath), containerPath);
  }

  return {
    ownedPaths: nextOwned,
    createdContainers: [...containers.values()],
    changes,
    released,
  };
}

function baseOwnershipEntry({
  filePath,
  kind,
  exists,
  currentText,
  nextText,
  previousEntry,
}) {
  const currentHash = exists ? sha256Hex(currentText) : null;
  const previousStillWhole =
    previousEntry?.wholeFileOwned === true
    && currentHash === previousEntry.appliedFileHash;
  return {
    path: filePath,
    kind,
    createdByGateway: previousEntry?.createdByGateway ?? !exists,
    wholeFileOwned: previousEntry === undefined ? !exists : previousStillWhole,
    originalFileHash: previousEntry?.originalFileHash ?? currentHash,
    appliedFileHash: sha256Hex(nextText),
    backupPath: previousEntry?.backupPath ?? null,
    ownedPaths: cloneJson(previousEntry?.ownedPaths ?? []),
    createdContainers: cloneJson(previousEntry?.createdContainers ?? []),
    managedBlocks: cloneJson(previousEntry?.managedBlocks ?? []),
  };
}

function applyJsonChange(root, change) {
  if (change.value === undefined) {
    deleteJsonPath(root, change.path);
  } else {
    setJsonPath(root, change.path, change.value);
  }
}

function createOwnedJsonPlan({
  client,
  filePath,
  kind,
  exists,
  currentText,
  source,
  desiredValues,
  releasePaths,
  previousEntry,
  force,
  jsonc,
}) {
  const prepared = prepareOwnedJsonChanges({
    source,
    desiredValues,
    releasePaths,
    previousEntry,
    force,
    filePath,
  });
  if (prepared.released) {
    // Releasing a value can empty a container the gateway created for it.
    const work = cloneJson(source);
    for (const change of prepared.changes) {
      applyJsonChange(work, change);
    }
    cleanupCreatedContainers(work, prepared.createdContainers, prepared.changes);
  }
  let nextText = currentText;
  if (prepared.changes.length > 0) {
    if (jsonc) {
      nextText = applyJsoncChanges(currentText, prepared.changes);
    } else {
      const nextObject = cloneJson(source);
      for (const change of prepared.changes) {
        applyJsonChange(nextObject, change);
      }
      nextText = stringifyJsonLike(nextObject, currentText, !exists);
    }
  }

  const entry = baseOwnershipEntry({
    filePath,
    kind,
    exists,
    currentText,
    nextText,
    previousEntry,
  });
  entry.ownedPaths = prepared.ownedPaths;
  entry.createdContainers = prepared.createdContainers;

  return {
    client,
    path: filePath,
    kind,
    exists,
    currentText: exists ? currentText : null,
    nextText,
    entry,
    action: nextText === currentText ? 'unchanged' : exists ? 'update' : 'create',
    conflicts: [],
  };
}

function claudeEffortValues({ claudeModel, effort, modelEfforts, explicitEffort }) {
  if (effort === undefined) {
    return [];
  }
  const policy = explicitEffort ? 'replace' : 'prefer-user';
  // Settings cannot hold max, so max goes through the environment variable,
  // which also overrides /effort and --effort for the whole session.
  if (effort === 'max') {
    return [{ path: ['env', CLAUDE_EFFORT_ENV], value: effort, policy }];
  }
  // Everything else is saved per model, where Claude Code's own /effort saves
  // a choice. A top-level effortLevel is not enough: Claude Code ignores it for
  // newer models, and a request to Opus 5.5 still carried "medium".
  const levels = modelEfforts ?? { [claudeModel]: effort };
  return Object.entries(levels).map(([model, level]) => ({
    path: ['modelSettings', model, 'effortLevel'],
    value: level,
    policy,
  }));
}

export function isClaudeEffortPath(jsonPath) {
  return (jsonPath.length === 2 && jsonPath[0] === 'env' && jsonPath[1] === CLAUDE_EFFORT_ENV)
    || (jsonPath.length === 3 && jsonPath[0] === 'modelSettings' && jsonPath[2] === 'effortLevel');
}

function claudeDesiredValues({
  baseUrl,
  claudeModel,
  sonnetModel = claudeModel,
  opusModel = claudeModel,
  fastModel,
  effort,
  modelEfforts,
  explicitEffort = false,
  setDefault = false,
  platform = process.platform,
}) {
  const helper = claudeApiKeyHelper(platform);
  const desired = [
    { path: ['apiKeyHelper'], value: helper },
    { path: ['env', 'ANTHROPIC_BASE_URL'], value: baseUrl },
    { path: ['env', 'ANTHROPIC_DEFAULT_SONNET_MODEL'], value: sonnetModel },
    { path: ['env', 'ANTHROPIC_DEFAULT_OPUS_MODEL'], value: opusModel },
    { path: ['env', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'], value: fastModel },
    ...claudeEffortValues({ claudeModel, effort, modelEfforts, explicitEffort }),
  ];
  if (setDefault) {
    desired.push({ path: ['model'], value: claudeModel });
  }
  return desired;
}

export function mergeClaudeSettings(settings, options) {
  if (!isPlainObject(settings)) {
    throw new TypeError('Claude settings must be an object.');
  }
  const next = cloneJson(settings);
  const helper = getJsonPathState(next, ['apiKeyHelper']);
  const desiredHelper = claudeApiKeyHelper(options.platform);
  if (
    helper.present
    && helper.value !== desiredHelper
    && options.force !== true
  ) {
    throw new Error('Claude Code already has a different apiKeyHelper; use --force to replace it.');
  }
  for (const desired of claudeDesiredValues(options)) {
    const current = getJsonPathState(next, desired.path);
    if (desired.policy === 'prefer-user' && current.present) {
      continue;
    }
    setJsonPath(next, desired.path, desired.value);
  }
  return next;
}

function openCodeModels(models) {
  return Object.fromEntries(
    models.map(({ id }) => [
      id,
      {
        name: id,
        tool_call: true,
      },
    ]),
  );
}

function openCodeEnabledProvidersDesired(source, previousEntry) {
  const enabledPath = ['enabled_providers'];
  const current = getJsonPathState(source, enabledPath);
  if (!current.present) {
    return null;
  }
  if (
    !Array.isArray(current.value)
    || current.value.some((provider) => typeof provider !== 'string')
  ) {
    throw new Error('OpenCode enabled_providers must be an array of provider IDs.');
  }

  const previous = previousEntry?.ownedPaths?.find((entry) =>
    jsonPathKey(entry.path) === jsonPathKey(enabledPath)
    && entry.mode === 'array-member'
    && entry.member === ANTHROPIC_PROVIDER_ID);
  const alreadyEnabled = current.value.includes(ANTHROPIC_PROVIDER_ID);
  if (alreadyEnabled && !previous) {
    return null;
  }

  return {
    path: enabledPath,
    value: alreadyEnabled
      ? [...current.value]
      : [...current.value, ANTHROPIC_PROVIDER_ID],
    mode: 'array-member',
    member: ANTHROPIC_PROVIDER_ID,
  };
}

function openCodeDesiredValues({
  baseUrl,
  models,
  defaultModel,
  fastModel,
  setDefault = false,
  source = {},
  previousEntry,
}) {
  const desired = [
    {
      path: ['provider', ANTHROPIC_PROVIDER_ID, 'name'],
      value: 'Copilot Harness Gateway (Anthropic Messages)',
    },
    {
      path: ['provider', ANTHROPIC_PROVIDER_ID, 'npm'],
      value: '@ai-sdk/anthropic',
    },
    {
      path: ['provider', ANTHROPIC_PROVIDER_ID, 'options', 'baseURL'],
      value: `${baseUrl}/v1`,
    },
    {
      path: ['provider', ANTHROPIC_PROVIDER_ID, 'options', 'apiKey'],
      value: `{env:${CLIENT_API_KEY_ENV}}`,
    },
    {
      path: ['provider', ANTHROPIC_PROVIDER_ID, 'models'],
      value: openCodeModels(models),
    },
  ];
  if (setDefault) {
    desired.push(
      {
        path: ['model'],
        value: `${ANTHROPIC_PROVIDER_ID}/${defaultModel}`,
      },
      {
        path: ['small_model'],
        value: `${ANTHROPIC_PROVIDER_ID}/${fastModel}`,
      },
    );
  }
  const enabledProviders = openCodeEnabledProvidersDesired(source, previousEntry);
  if (enabledProviders !== null) {
    desired.push(enabledProviders);
  }
  return desired;
}

export function mergeOpenCodeJsonc(text, options) {
  const sourceText = text.length === 0 ? '{}\n' : text;
  const source = parseJsoncObject(sourceText, options.filePath ?? 'OpenCode configuration');
  const changes = [];
  for (const desired of openCodeDesiredValues({ ...options, source })) {
    const current = getJsonPathState(source, desired.path);
    if (!current.present || !valuesEqual(current.value, desired.value)) {
      changes.push(desired);
      setJsonPath(source, desired.path, desired.value);
    }
  }
  return changes.length === 0 ? sourceText : applyJsoncChanges(sourceText, changes);
}

function piModelsDesiredValues({ baseUrl, models }) {
  return [
    {
      path: ['providers', ANTHROPIC_PROVIDER_ID, 'baseUrl'],
      value: baseUrl,
    },
    {
      path: ['providers', ANTHROPIC_PROVIDER_ID, 'api'],
      value: 'anthropic-messages',
    },
    {
      path: ['providers', ANTHROPIC_PROVIDER_ID, 'apiKey'],
      value: `$${CLIENT_API_KEY_ENV}`,
    },
    {
      path: ['providers', ANTHROPIC_PROVIDER_ID, 'models'],
      value: models.map(({ id }) => ({ id })),
    },
  ];
}

function piSettingsDesiredValues({ defaultModel }) {
  return [
    {
      path: ['defaultProvider'],
      value: ANTHROPIC_PROVIDER_ID,
    },
    {
      path: ['defaultModel'],
      value: defaultModel,
    },
  ];
}

export function mergePiModels(modelsConfig, options) {
  if (!isPlainObject(modelsConfig)) {
    throw new TypeError('Pi models configuration must be an object.');
  }
  const next = cloneJson(modelsConfig);
  for (const desired of piModelsDesiredValues(options)) {
    setJsonPath(next, desired.path, desired.value);
  }
  return next;
}

export function mergePiSettings(settings, options) {
  if (!isPlainObject(settings)) {
    throw new TypeError('Pi settings must be an object.');
  }
  const next = cloneJson(settings);
  for (const desired of piSettingsDesiredValues(options)) {
    setJsonPath(next, desired.path, desired.value);
  }
  return next;
}

function textLines(text) {
  const lines = [];
  let offset = 0;
  while (offset < text.length) {
    const newline = text.indexOf('\n', offset);
    const end = newline === -1 ? text.length : newline + 1;
    let contentEnd = newline === -1 ? text.length : newline;
    if (contentEnd > offset && text[contentEnd - 1] === '\r') {
      contentEnd -= 1;
    }
    const contentStart =
      offset === 0 && text.charCodeAt(0) === 0xFEFF
        ? 1
        : offset;
    lines.push({
      start: offset,
      contentStart,
      end,
      contentEnd,
      content: text.slice(contentStart, contentEnd),
    });
    offset = end;
  }
  return lines;
}

function locateMarkerBlock(text, beginMarker, endMarker, label) {
  const lines = textLines(text);
  const begins = lines.filter((line) => line.content === beginMarker);
  const ends = lines.filter((line) => line.content === endMarker);
  if (begins.length === 0 && ends.length === 0) {
    return null;
  }
  if (begins.length !== 1 || ends.length !== 1 || begins[0].start >= ends[0].start) {
    throw new Error(`Codex configuration has malformed or duplicate ${label} marker blocks.`);
  }
  return {
    start: begins[0].contentStart,
    end: ends[0].contentEnd,
    text: text.slice(begins[0].start, ends[0].contentEnd),
  };
}

function codexMarkerRanges(text) {
  const provider = locateMarkerBlock(
    text,
    CODEX_PROVIDER_BEGIN,
    CODEX_PROVIDER_END,
    'provider',
  );
  const defaults = locateMarkerBlock(
    text,
    CODEX_DEFAULTS_BEGIN,
    CODEX_DEFAULTS_END,
    'defaults',
  );
  if (
    provider
    && defaults
    && provider.start < defaults.end
    && defaults.start < provider.end
  ) {
    throw new Error('Codex configuration marker blocks may not overlap.');
  }
  return { provider, defaults };
}

function offsetInsideRange(offset, range) {
  return range !== null && offset >= range.start && offset < range.end;
}

function isTomlTableHeader(line) {
  return /^\s*\[[^\]\r\n]+\]\s*(?:#.*)?$/.test(line.content);
}

function findProviderTables(text) {
  const ranges = codexMarkerRanges(text);
  return textLines(text).filter((line) =>
    /^\s*\[model_providers\.copilot_harness_gateway\]\s*(?:#.*)?$/.test(line.content)
    && !offsetInsideRange(line.contentStart, ranges.provider));
}

function unmarkedTableRange(text, headerLine) {
  const lines = textLines(text);
  const startIndex = lines.findIndex((line) => line.start === headerLine.start);
  let nextTableStart = text.length;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (isTomlTableHeader(lines[index])) {
      nextTableStart = lines[index].start;
      break;
    }
  }

  let lastContentEnd = headerLine.contentEnd;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.start >= nextTableStart) {
      break;
    }
    if (line.content.trim().length > 0) {
      lastContentEnd = line.contentEnd;
    }
  }
  return {
    start: headerLine.contentStart,
    end: lastContentEnd,
    text: text.slice(headerLine.contentStart, lastContentEnd),
  };
}

function replaceTextRange(text, range, replacement) {
  return `${text.slice(0, range.start)}${replacement}${text.slice(range.end)}`;
}

function appendManagedBlock(text, block, eol) {
  if (text.length === 0) {
    return {
      text: `${block}${eol}`,
      leadingText: '',
      trailingText: eol,
    };
  }
  if (text.endsWith(`${eol}${eol}`)) {
    return {
      text: `${text}${block}${eol}`,
      leadingText: '',
      trailingText: eol,
    };
  }
  if (text.endsWith(eol)) {
    return {
      text: `${text}${eol}${block}${eol}`,
      leadingText: eol,
      trailingText: eol,
    };
  }
  return {
    text: `${text}${eol}${eol}${block}${eol}`,
    leadingText: `${eol}${eol}`,
    trailingText: eol,
  };
}

function insertBlockBeforeFirstTable(text, block, eol) {
  const ranges = codexMarkerRanges(text);
  const firstUnmanagedTable = textLines(text).find((line) =>
    isTomlTableHeader(line)
    && !offsetInsideRange(line.contentStart, ranges.provider)
    && !offsetInsideRange(line.contentStart, ranges.defaults));
  const managedStarts = [ranges.provider?.start, ranges.defaults?.start]
    .filter((offset) => offset !== undefined)
    .toSorted((left, right) => left - right);
  const insertionOffset = firstUnmanagedTable?.contentStart ?? managedStarts[0];
  if (insertionOffset === undefined) {
    return appendManagedBlock(text, block, eol);
  }
  const prefix = text.slice(0, insertionOffset);
  const suffix = text.slice(insertionOffset);
  const before = prefix.length > 0 && !prefix.endsWith(eol) ? eol : '';
  return {
    text: `${prefix}${before}${block}${eol}${eol}${suffix}`,
    leadingText: before,
    trailingText: `${eol}${eol}`,
  };
}

function externalCodexDefaults(text) {
  const defaultsRange = codexMarkerRanges(text).defaults;
  const found = new Set();
  for (const line of textLines(text)) {
    if (offsetInsideRange(line.contentStart, defaultsRange)) {
      continue;
    }
    if (isTomlTableHeader(line)) {
      break;
    }
    const match = line.content.match(/^\s*(model|model_provider|model_reasoning_effort)\s*=/);
    if (match) {
      found.add(match[1]);
    }
  }
  return found;
}

const CODEX_PROVIDER_HEADER = /^\s*\[model_providers\.copilot_harness_gateway\]\s*(?:#.*)?$/;
const CODEX_DEFAULT_KEY = /^\s*(model_provider|model|model_reasoning_effort)\s*=/;

function withoutFinalEol(text) {
  return text.replace(/\r?\n$/, '');
}

function sameManagedText(left, right) {
  const normalize = (value) =>
    value.split(/\r?\n/).map((line) => line.trimEnd()).join('\n').trim();
  return normalize(left) === normalize(right);
}

/** The lines strictly between a block's begin and end markers, with EOLs. */
function innerMarkerLines(blockText) {
  return textLines(blockText)
    .slice(1, -1)
    .map((line) => blockText.slice(line.start, line.end));
}

/**
 * Separates the gateway's table from anything else inside the provider
 * markers.
 *
 * TOML editors that preserve comments attach them to neighbouring items, so
 * a tool that rewrites config.toml can leave its own keys and tables between
 * these markers. The Codex desktop app does exactly that. Treating the whole
 * block as ours then meant either refusing to run or deleting the other
 * tool's settings. Only the table is ours; `before` and `after` are kept.
 */
function splitProviderBlock(blockText) {
  const inner = innerMarkerLines(blockText);
  const headerIndex = inner.findIndex((line) =>
    CODEX_PROVIDER_HEADER.test(withoutFinalEol(line)));
  if (headerIndex === -1) {
    return null;
  }
  let endIndex = inner.length;
  for (let index = headerIndex + 1; index < inner.length; index += 1) {
    if (isTomlTableHeader({ content: withoutFinalEol(inner[index]) })) {
      endIndex = index;
      break;
    }
  }
  return {
    before: inner.slice(0, headerIndex).join(''),
    table: inner.slice(headerIndex, endIndex).join(''),
    after: inner.slice(endIndex).join(''),
  };
}

/** Separates the gateway's top-level keys from other lines in the defaults block. */
function splitDefaultsBlock(blockText) {
  const ours = [];
  const foreign = [];
  for (const line of innerMarkerLines(blockText)) {
    const content = withoutFinalEol(line);
    if (CODEX_DEFAULT_KEY.test(content)) {
      ours.push(content.trim());
    } else if (content.trim().length > 0) {
      foreign.push(line);
    }
  }
  return { ours, foreign: foreign.join('') };
}

function modelDefaultLines(lines) {
  return lines.filter((line) => !line.startsWith('model_reasoning_effort')).join('\n');
}

function previousManagedBlock(previousBlocks, name) {
  return previousBlocks?.find((block) => block.name === name);
}

function checkManagedBlockConflict({
  current,
  desired,
  previous,
  force,
  filePath,
  name,
}) {
  if (
    previous
    && current !== previous.appliedText
    && current !== desired
    && !force
  ) {
    throw new Error(
      `Refusing to replace a user-modified Codex ${name} block in "${filePath}" without --force.`,
    );
  }
}

function codexProviderBlock(baseUrl, eol) {
  return [
    CODEX_PROVIDER_BEGIN,
    `[model_providers.${CODEX_PROVIDER_ID}]`,
    'name = "Copilot Harness Gateway"',
    `base_url = ${JSON.stringify(`${baseUrl}/v1`)}`,
    `env_key = ${JSON.stringify(CLIENT_API_KEY_ENV)}`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    'supports_websockets = false',
    CODEX_PROVIDER_END,
  ].join(eol);
}

function codexDefaultsBlock(model, eol, reasoningEffort) {
  const lines = [
    CODEX_DEFAULTS_BEGIN,
    `model_provider = ${JSON.stringify(CODEX_PROVIDER_ID)}`,
    `model = ${JSON.stringify(model)}`,
  ];
  if (reasoningEffort !== undefined) {
    lines.push(`model_reasoning_effort = ${JSON.stringify(reasoningEffort)}`);
  }
  lines.push(CODEX_DEFAULTS_END);
  return lines.join(eol);
}

export function mergeCodexConfig(
  text,
  {
    baseUrl,
    model,
    reasoningEffort,
    setDefault = false,
    force = false,
    previousBlocks = [],
    filePath = 'Codex configuration',
  },
) {
  if (typeof text !== 'string') {
    throw new TypeError('Codex configuration must be text.');
  }
  if (text.includes('\u0000')) {
    throw new Error(`Invalid NUL byte in "${filePath}".`);
  }
  try {
    parseToml(text.startsWith('\uFEFF') ? text.slice(1) : text);
  } catch (error) {
    throw new Error(`Invalid TOML in "${filePath}".`, { cause: error });
  }
  if (setDefault) {
    validateModelId(model);
  }
  const eol = detectTextStyle(text).eol;
  const providerBlock = codexProviderBlock(baseUrl, eol);
  const providerPrevious = previousManagedBlock(previousBlocks, 'provider');
  let output = text;
  let providerOriginal;
  let providerLeadingText = providerPrevious?.leadingText ?? '';
  let providerTrailingText = providerPrevious?.trailingText ?? '';

  const initialProviderRange = codexMarkerRanges(output).provider;
  const unmarkedProviders = findProviderTables(output);
  if (initialProviderRange && unmarkedProviders.length > 0) {
    throw new Error(
      `Codex configuration "${filePath}" defines the gateway provider both inside and outside the managed block.`,
    );
  }

  if (initialProviderRange) {
    const split = splitProviderBlock(initialProviderRange.text);
    if (split === null) {
      checkManagedBlockConflict({
        current: initialProviderRange.text,
        desired: providerBlock,
        previous: providerPrevious,
        force,
        filePath,
        name: 'provider',
      });
      output = replaceTextRange(output, initialProviderRange, providerBlock);
    } else {
      // Only a change to the gateway's own table counts as a user edit;
      // other tools' content around it is expected and is preserved.
      const desiredTable = splitProviderBlock(providerBlock).table;
      const previousTable = providerPrevious
        ? splitProviderBlock(providerPrevious.appliedText)?.table
        : undefined;
      if (
        previousTable !== undefined
        && !sameManagedText(split.table, previousTable)
        && !sameManagedText(split.table, desiredTable)
        && !force
      ) {
        throw new Error(
          `Refusing to replace a user-modified Codex provider block in "${filePath}" without --force.`,
        );
      }
      // The markers are comments, so moving them around the foreign content
      // leaves the meaning of the file unchanged.
      const after = split.after.trim().length > 0
        ? `${eol}${withoutFinalEol(split.after)}`
        : '';
      output = replaceTextRange(
        output,
        initialProviderRange,
        `${split.before}${providerBlock}${after}`,
      );
    }
    providerOriginal = providerPrevious?.original ?? { present: false };
  } else if (unmarkedProviders.length > 0) {
    if (unmarkedProviders.length !== 1) {
      throw new Error(`Codex configuration "${filePath}" has duplicate unmarked gateway provider tables.`);
    }
    if (!force) {
      throw new Error(
        `Codex configuration "${filePath}" has an unmarked [model_providers.${CODEX_PROVIDER_ID}] table; use --force to adopt it.`,
      );
    }
    if (providerPrevious && !force) {
      throw new Error(
        `The managed Codex provider block in "${filePath}" was removed; use --force to recreate it.`,
      );
    }
    const tableRange = unmarkedTableRange(output, unmarkedProviders[0]);
    providerOriginal = providerPrevious?.original ?? {
      present: true,
      text: tableRange.text,
    };
    output = replaceTextRange(output, tableRange, providerBlock);
  } else {
    if (providerPrevious && !force) {
      throw new Error(
        `The managed Codex provider block in "${filePath}" was removed; use --force to recreate it.`,
      );
    }
    providerOriginal = providerPrevious?.original ?? { present: false };
    const appended = appendManagedBlock(output, providerBlock, eol);
    output = appended.text;
    providerLeadingText = appended.leadingText;
    providerTrailingText = appended.trailingText;
  }

  const managedBlocks = [
    {
      name: 'provider',
      beginMarker: CODEX_PROVIDER_BEGIN,
      endMarker: CODEX_PROVIDER_END,
      original: cloneJson(providerOriginal),
      appliedText: providerBlock,
      appliedHash: sha256Hex(providerBlock),
      leadingText: providerLeadingText,
      trailingText: providerTrailingText,
    },
  ];
  let defaultSkipped = false;

  if (setDefault) {
    const externalDefaults = externalCodexDefaults(output);
    // Repeating a top-level key makes the whole file invalid TOML, so an
    // effort that another tool already set is left to that tool.
    const effort = externalDefaults.has('model_reasoning_effort')
      ? undefined
      : reasoningEffort;
    const externalModelDefaults = [...externalDefaults]
      .filter((key) => key !== 'model_reasoning_effort');
    const defaultsBlock = codexDefaultsBlock(model, eol, effort);
    const defaultsPrevious = previousManagedBlock(previousBlocks, 'defaults');
    const defaultsRange = codexMarkerRanges(output).defaults;
    if (defaultsRange) {
      if (externalModelDefaults.length > 0) {
        throw new Error(
          `Codex configuration "${filePath}" has conflicting managed and unmarked top-level model defaults.`,
        );
      }
      const split = splitDefaultsBlock(defaultsRange.text);
      const previousOurs = defaultsPrevious
        ? splitDefaultsBlock(defaultsPrevious.appliedText).ours
        : undefined;
      const desiredOurs = splitDefaultsBlock(defaultsBlock).ours;
      if (
        previousOurs !== undefined
        && modelDefaultLines(split.ours) !== modelDefaultLines(previousOurs)
        && modelDefaultLines(split.ours) !== modelDefaultLines(desiredOurs)
        && !force
      ) {
        throw new Error(
          `Refusing to replace a user-modified Codex defaults block in "${filePath}" without --force.`,
        );
      }
      const trailing = split.foreign.length > 0
        ? `${eol}${withoutFinalEol(split.foreign)}`
        : '';
      output = replaceTextRange(output, defaultsRange, `${defaultsBlock}${trailing}`);
      managedBlocks.push({
        name: 'defaults',
        beginMarker: CODEX_DEFAULTS_BEGIN,
        endMarker: CODEX_DEFAULTS_END,
        original: cloneJson(defaultsPrevious?.original ?? { present: false }),
        appliedText: defaultsBlock,
        appliedHash: sha256Hex(defaultsBlock),
        leadingText: defaultsPrevious?.leadingText ?? '',
        trailingText: defaultsPrevious?.trailingText ?? '',
      });
    } else if (externalModelDefaults.length > 0) {
      defaultSkipped = true;
    } else {
      if (defaultsPrevious && !force) {
        throw new Error(
          `The managed Codex defaults block in "${filePath}" was removed; use --force to recreate it.`,
        );
      }
      const inserted = insertBlockBeforeFirstTable(output, defaultsBlock, eol);
      output = inserted.text;
      managedBlocks.push({
        name: 'defaults',
        beginMarker: CODEX_DEFAULTS_BEGIN,
        endMarker: CODEX_DEFAULTS_END,
        original: cloneJson(defaultsPrevious?.original ?? { present: false }),
        appliedText: defaultsBlock,
        appliedHash: sha256Hex(defaultsBlock),
        leadingText: inserted.leadingText,
        trailingText: inserted.trailingText,
      });
    }
  }

  // Last line of defence: never hand Codex a file it cannot parse. A broken
  // config.toml stops both the CLI and the desktop app from starting.
  let parsedOutput;
  try {
    parsedOutput = parseToml(output.startsWith('\uFEFF') ? output.slice(1) : output);
  } catch (error) {
    throw new Error(
      `Refusing to write invalid TOML to "${filePath}"; the file was left unchanged.`,
      { cause: error },
    );
  }
  if (parsedOutput?.model_providers?.[CODEX_PROVIDER_ID]?.base_url !== `${baseUrl}/v1`) {
    throw new Error(
      `The gateway provider did not survive editing "${filePath}"; the file was left unchanged.`,
    );
  }

  return {
    text: output,
    managedBlocks,
    defaultSkipped,
  };
}

function ownershipFilePath(root) {
  return path.join(path.resolve(root), 'state', 'client-ownership.json');
}

function emptyOwnershipState() {
  return {
    schemaVersion: OWNERSHIP_SCHEMA_VERSION,
    clients: {},
  };
}

function validateOwnedPath(record, filePath) {
  if (
    !isPlainObject(record)
    || !Array.isArray(record.path)
    || record.path.length === 0
    || record.path.some((segment) =>
      typeof segment !== 'string'
      || ['__proto__', 'prototype', 'constructor'].includes(segment))
    || !isPlainObject(record.original)
    || typeof record.original.present !== 'boolean'
    || !Object.prototype.hasOwnProperty.call(record, 'applied')
  ) {
    throw new Error(`Invalid owned path record for "${filePath}".`);
  }
}

function validateOwnershipEntry(entry) {
  if (
    !isPlainObject(entry)
    || typeof entry.path !== 'string'
    || !['json', 'jsonc', 'toml-markers'].includes(entry.kind)
    || typeof entry.createdByGateway !== 'boolean'
    || typeof entry.wholeFileOwned !== 'boolean'
    || (
      entry.originalFileHash !== null
      && (typeof entry.originalFileHash !== 'string' || !/^[a-f0-9]{64}$/.test(entry.originalFileHash))
    )
    || typeof entry.appliedFileHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(entry.appliedFileHash)
    || !Array.isArray(entry.ownedPaths)
    || !Array.isArray(entry.createdContainers)
    || !Array.isArray(entry.managedBlocks)
  ) {
    throw new Error('Invalid client ownership file record.');
  }
  for (const ownedPath of entry.ownedPaths) {
    validateOwnedPath(ownedPath, entry.path);
  }
  for (const container of entry.createdContainers) {
    if (
      !Array.isArray(container)
      || container.length === 0
      || container.some((segment) =>
        typeof segment !== 'string'
        || ['__proto__', 'prototype', 'constructor'].includes(segment))
    ) {
      throw new Error(`Invalid created-container record for "${entry.path}".`);
    }
  }
  for (const block of entry.managedBlocks) {
    if (
      !isPlainObject(block)
      || typeof block.name !== 'string'
      || typeof block.beginMarker !== 'string'
      || typeof block.endMarker !== 'string'
      || !isPlainObject(block.original)
      || typeof block.original.present !== 'boolean'
      || typeof block.appliedText !== 'string'
      || (block.leadingText !== undefined && typeof block.leadingText !== 'string')
      || (block.trailingText !== undefined && typeof block.trailingText !== 'string')
    ) {
      throw new Error(`Invalid managed block record for "${entry.path}".`);
    }
  }
}

function validateOwnershipState(value, source) {
  if (
    !isPlainObject(value)
    || value.schemaVersion !== OWNERSHIP_SCHEMA_VERSION
    || !isPlainObject(value.clients)
  ) {
    throw new Error(`Invalid client ownership state in "${source}".`);
  }
  for (const [client, clientState] of Object.entries(value.clients)) {
    if (
      !CLIENT_NAMES.includes(client)
      || !isPlainObject(clientState)
      || !Array.isArray(clientState.files)
    ) {
      throw new Error(`Invalid ownership state for client "${client}".`);
    }
    for (const entry of clientState.files) {
      validateOwnershipEntry(entry);
    }
  }
  return cloneJson(value);
}

async function readOwnershipState(root) {
  const filePath = ownershipFilePath(root);
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        path: filePath,
        text: null,
        state: emptyOwnershipState(),
      };
    }
    throw new Error(`Unable to read client ownership state "${filePath}".`, { cause: error });
  }

  let value;
  try {
    value = JSON.parse(text.startsWith('\uFEFF') ? text.slice(1) : text);
  } catch (error) {
    throw new Error(`Invalid JSON in client ownership state "${filePath}".`, { cause: error });
  }
  return {
    path: filePath,
    text,
    state: validateOwnershipState(value, filePath),
  };
}

function sameFilePath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function clientOwnershipFiles(state, client) {
  return state.clients[client]?.files ?? [];
}

function findOwnershipEntry(state, client, filePath) {
  return clientOwnershipFiles(state, client)
    .find((entry) => sameFilePath(entry.path, filePath));
}

function setOwnershipEntry(state, client, entry) {
  const existing = clientOwnershipFiles(state, client);
  const files = existing.filter((candidate) => !sameFilePath(candidate.path, entry.path));
  files.push(cloneJson(entry));
  state.clients[client] = { files };
}

function removeOwnershipEntry(state, client, filePath) {
  const files = clientOwnershipFiles(state, client)
    .filter((candidate) => !sameFilePath(candidate.path, filePath));
  if (files.length === 0) {
    delete state.clients[client];
  } else {
    state.clients[client] = { files };
  }
}

async function readOptionalText(filePath) {
  try {
    return {
      exists: true,
      text: await readFile(filePath, 'utf8'),
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { exists: false, text: null };
    }
    throw new Error(`Unable to read client configuration "${filePath}".`, { cause: error });
  }
}

function isClaudeModel(modelId) {
  const normalized = modelId.toLowerCase();
  return ['claude', 'sonnet', 'opus', 'haiku'].some((family) => normalized.includes(family));
}

function newestModel(models, predicate) {
  const matches = models
    .map((model) => model.id)
    .filter((id) => predicate(id.toLowerCase()))
    .toSorted(compareModelIds);
  return matches.at(-1);
}

/**
 * Picks the reasoning effort to configure for a model.
 *
 * Asking for more than a model supports gets the request rejected upstream,
 * which matters when a preferred model is missing and a fallback is chosen:
 * gpt-5.3-codex, for example, stops at "xhigh". The request is clamped down to
 * the strongest level the model advertises. A model that advertises no levels
 * gets none, and one with no capability data is trusted with the request.
 */
export function effortForModel(requested, model) {
  if (requested === undefined || requested === 'default') {
    return undefined;
  }
  const supported = model?.capabilities?.supports?.reasoning_effort;
  if (!Array.isArray(supported)) {
    return requested;
  }
  for (let index = EFFORT_LEVELS.indexOf(requested); index >= 0; index -= 1) {
    if (supported.includes(EFFORT_LEVELS[index])) {
      return EFFORT_LEVELS[index];
    }
  }
  return undefined;
}

function cappedEffort(requested, ceiling) {
  return EFFORT_LEVELS.indexOf(requested) > EFFORT_LEVELS.indexOf(ceiling) ? ceiling : requested;
}

export function selectClientModels(catalog, options, preferences = {}) {
  const ids = new Set(catalog.models.map((model) => model.id));
  for (const [optionName, modelId] of [
    ['--model', options.model],
    ['--claude-model', options.claudeModel],
    ['--sonnet-model', options.sonnetModel],
    ['--opus-model', options.opusModel],
    ['--codex-model', options.codexModel],
    ['--fast-model', options.fastModel],
  ]) {
    if (modelId !== undefined && !ids.has(modelId)) {
      throw new Error(`${optionName} selects model "${modelId}", which is not in the discovered catalog.`);
    }
  }

  // A saved choice applies only while the account can still see the model;
  // otherwise it falls back rather than failing every later re-link.
  const saved = {};
  for (const key of ['claudeModel', 'sonnetModel', 'opusModel', 'fastModel', 'codexModel']) {
    if (typeof preferences[key] === 'string' && ids.has(preferences[key])) {
      saved[key] = preferences[key];
    }
  }
  const preferred = (candidates) => candidates.find((id) => ids.has(id));
  const newestClaude = (family) => newestModel(
    catalog.models,
    (id) => id.includes('claude') && id.includes(family),
  );

  const defaultModel = options.model ?? catalog.aliases.default;
  const explicitClaude = options.claudeModel ?? options.model;
  const claudeFallback = catalog.aliases.claude ?? defaultModel;

  // An explicit --claude-model fills both slots, which is what pinning one
  // model means; --sonnet-model and --opus-model set the slots separately.
  const opusModel = options.opusModel
    ?? explicitClaude
    ?? saved.opusModel
    ?? preferred(PREFERRED_MODELS.opus)
    ?? newestClaude('opus')
    ?? claudeFallback;
  const sonnetModel = options.sonnetModel
    ?? explicitClaude
    ?? saved.sonnetModel
    ?? preferred(PREFERRED_MODELS.sonnet)
    ?? newestClaude('sonnet')
    ?? claudeFallback;
  // Claude Code starts on the Opus slot: the strongest model is the point.
  const claudeModel = explicitClaude
    ?? saved.claudeModel
    ?? (typeof opusModel === 'string' && isClaudeModel(opusModel) ? opusModel : claudeFallback);
  const codexModel = options.codexModel
    ?? options.model
    ?? saved.codexModel
    ?? preferred(PREFERRED_MODELS.codex)
    ?? catalog.aliases.codex
    ?? defaultModel;
  const chosenFast = options.fastModel ?? options.model ?? saved.fastModel;
  const fastModel = chosenFast ?? catalog.aliases.fast ?? defaultModel;

  for (const [selection, modelId] of Object.entries({
    defaultModel,
    claudeModel,
    codexModel,
    fastModel,
  })) {
    if (typeof modelId !== 'string' || !ids.has(modelId)) {
      throw new Error(`Unable to resolve a valid ${selection} from the discovered model catalog.`);
    }
  }

  // A chosen fast model is used as-is. Otherwise Claude Code's background
  // slot needs a Claude model, so a non-Claude default is swapped for Haiku,
  // or for Sonnet rather than Opus: background calls should stay light.
  const claudeFastModel = chosenFast !== undefined || isClaudeModel(fastModel)
    ? fastModel
    : newestClaude('haiku') ?? sonnetModel ?? claudeModel;

  const modelById = (id) => catalog.models.find((model) => model.id === id);
  const claudeRequest = options.claudeEffort ?? preferences.claudeEffort ?? DEFAULT_EFFORTS.claude;
  const codexRequest = options.codexEffort ?? preferences.codexEffort ?? DEFAULT_EFFORTS.codex;
  const claudeEffort = effortForModel(claudeRequest, modelById(claudeModel));
  // Claude Code keeps effort per model, so every model it can switch to gets
  // its own level. These are only written below max, which settings cannot hold.
  const claudeModelEfforts = {};
  for (const id of new Set([claudeModel, opusModel, sonnetModel])) {
    if (typeof id !== 'string' || !isClaudeModel(id)) {
      continue;
    }
    const level = effortForModel(
      cappedEffort(claudeRequest, CLAUDE_SETTINGS_EFFORT_CEILING),
      modelById(id),
    );
    if (level !== undefined) {
      claudeModelEfforts[id] = level;
    }
  }
  const codexEffort = effortForModel(codexRequest, modelById(codexModel));

  return {
    defaultModel,
    claudeModel,
    codexModel,
    fastModel,
    claudeFastModel,
    sonnetModel,
    opusModel,
    claudeEffort,
    claudeModelEfforts,
    codexEffort,
  };
}

function planClaude({
  paths,
  state,
  baseUrl,
  selections,
  models,
  options,
}) {
  return readOptionalText(paths.claude.settings).then((current) => {
    const sourceText = current.exists ? current.text : '{}\n';
    const source = current.exists
      ? parseStrictJsonObject(sourceText, paths.claude.settings)
      : {};
    const previousEntry = findOwnershipEntry(state, 'claude', paths.claude.settings);
    const existingHelper = getJsonPathState(source, ['apiKeyHelper']);
    const desiredHelper = claudeApiKeyHelper(options.platform);
    const previousHelper = previousEntry?.ownedPaths?.find(
      (owned) => jsonPathKey(owned.path) === jsonPathKey(['apiKeyHelper']),
    );
    if (
      existingHelper.present
      && existingHelper.value !== desiredHelper
      && (
        previousHelper === undefined
        || !valuesEqual(existingHelper.value, previousHelper.applied)
      )
      && !options.force
    ) {
      throw new Error(
        `Claude Code configuration "${paths.claude.settings}" already has a different apiKeyHelper; use --force to replace it.`,
      );
    }
    if (!isClaudeModel(selections.claudeModel) && !options.force) {
      throw new Error(
        `Claude Code requires a Claude-family model; "${selections.claudeModel}" requires --force.`,
      );
    }

    const desiredValues = claudeDesiredValues({
      baseUrl,
      claudeModel: selections.claudeModel,
      sonnetModel: selections.sonnetModel,
      opusModel: selections.opusModel,
      fastModel: selections.claudeFastModel,
      effort: selections.claudeEffort,
      modelEfforts: selections.claudeModelEfforts,
      explicitEffort: options.claudeEffort !== undefined,
      setDefault: options.setDefault,
      models,
    });
    // Effort the gateway set before but no longer wants, such as the
    // environment variable after moving from max to xhigh, or a model that
    // has left a slot, is released rather than left behind to override.
    const desiredKeys = new Set(desiredValues.map((desired) => jsonPathKey(desired.path)));
    const releasePaths = (previousEntry?.ownedPaths ?? [])
      .map((owned) => owned.path)
      .filter((ownedPath) => isClaudeEffortPath(ownedPath) && !desiredKeys.has(jsonPathKey(ownedPath)));

    return createOwnedJsonPlan({
      client: 'claude',
      filePath: paths.claude.settings,
      kind: 'json',
      exists: current.exists,
      currentText: sourceText,
      source,
      desiredValues,
      releasePaths,
      previousEntry,
      force: options.force,
      jsonc: false,
    });
  });
}

function mergeManagedBlockOwnership(previousEntry, managedBlocks) {
  const desiredNames = new Set(managedBlocks.map((block) => block.name));
  return [
    ...managedBlocks,
    ...(previousEntry?.managedBlocks ?? [])
      .filter((block) => !desiredNames.has(block.name))
      .map(cloneJson),
  ];
}

function planCodex({
  paths,
  state,
  baseUrl,
  selections,
  options,
}) {
  return readOptionalText(paths.codex.config).then((current) => {
    const sourceText = current.exists ? current.text : '';
    const previousEntry = findOwnershipEntry(state, 'codex', paths.codex.config);
    const merged = mergeCodexConfig(sourceText, {
      baseUrl,
      model: selections.codexModel,
      reasoningEffort: selections.codexEffort,
      setDefault: options.setDefault,
      force: options.force,
      previousBlocks: previousEntry?.managedBlocks ?? [],
      filePath: paths.codex.config,
    });
    const entry = baseOwnershipEntry({
      filePath: paths.codex.config,
      kind: 'toml-markers',
      exists: current.exists,
      currentText: sourceText,
      nextText: merged.text,
      previousEntry,
    });
    entry.managedBlocks = mergeManagedBlockOwnership(previousEntry, merged.managedBlocks);
    return {
      client: 'codex',
      path: paths.codex.config,
      kind: 'toml-markers',
      exists: current.exists,
      currentText: current.exists ? sourceText : null,
      nextText: merged.text,
      entry,
      action: merged.text === sourceText ? 'unchanged' : current.exists ? 'update' : 'create',
      conflicts: [],
      defaultSkipped: merged.defaultSkipped,
    };
  });
}

async function planOpenCode({
  paths,
  state,
  baseUrl,
  selections,
  models,
  options,
}) {
  const [configFile, jsonFile, jsoncFile] = await Promise.all([
    readOptionalText(paths.opencode.config),
    readOptionalText(paths.opencode.json),
    readOptionalText(paths.opencode.jsonc),
  ]);

  const configObject = configFile.exists
    ? parseJsoncObject(configFile.text, paths.opencode.config, { strict: true })
    : null;
  let jsonObject = null;
  let jsoncObject = null;
  if (jsonFile.exists) {
    jsonObject = parseJsoncObject(jsonFile.text, paths.opencode.json, { strict: true });
  }
  if (jsoncFile.exists) {
    jsoncObject = parseJsoncObject(jsoncFile.text, paths.opencode.jsonc);
  }
  let targetPath;
  let target;
  let source;
  if (paths.opencode.explicitTarget !== null) {
    targetPath = paths.opencode.explicitTarget;
    if (sameFilePath(targetPath, paths.opencode.jsonc)) {
      target = jsoncFile;
      source = jsoncFile.exists ? jsoncObject : {};
    } else if (sameFilePath(targetPath, paths.opencode.json)) {
      target = jsonFile;
      source = jsonFile.exists ? jsonObject : {};
    } else {
      target = await readOptionalText(targetPath);
      source = target.exists
        ? parseJsoncObject(
            target.text,
            targetPath,
            { strict: path.extname(targetPath).toLowerCase() === '.json' },
          )
        : {};
    }
  } else if (jsoncFile.exists) {
    targetPath = paths.opencode.jsonc;
    target = jsoncFile;
    source = jsoncObject;
  } else if (jsonFile.exists) {
    targetPath = paths.opencode.json;
    target = jsonFile;
    source = jsonObject;
  } else if (configFile.exists) {
    targetPath = paths.opencode.config;
    target = configFile;
    source = configObject;
  } else {
    targetPath = paths.opencode.jsonc;
    target = { exists: false, text: '{}\n' };
    source = {};
  }

  if (paths.opencode.explicitTarget === null) {
    for (const candidate of [
      { path: paths.opencode.config, file: configFile, object: configObject },
      { path: paths.opencode.json, file: jsonFile, object: jsonObject },
      { path: paths.opencode.jsonc, file: jsoncFile, object: jsoncObject },
    ]) {
      if (
        candidate.file.exists
        && !sameFilePath(candidate.path, targetPath)
        && getJsonPathState(
          candidate.object,
          ['provider', ANTHROPIC_PROVIDER_ID],
        ).present
      ) {
        throw new Error(
          `OpenCode provider "${ANTHROPIC_PROVIDER_ID}" is also defined in lower-priority "${candidate.path}"; refusing an ambiguous multi-file configuration.`,
        );
      }
    }
  }

  const previousEntry = findOwnershipEntry(state, 'opencode', targetPath);
  return createOwnedJsonPlan({
    client: 'opencode',
    filePath: targetPath,
    kind: 'jsonc',
    exists: target.exists,
    currentText: target.text,
    source,
    desiredValues: openCodeDesiredValues({
      baseUrl,
      models,
      defaultModel: selections.defaultModel,
      fastModel: selections.fastModel,
      setDefault: options.setDefault,
      source,
      previousEntry,
    }),
    previousEntry,
    force: options.force,
    jsonc: path.extname(targetPath).toLowerCase() === '.jsonc',
  });
}

async function planPi({
  paths,
  state,
  baseUrl,
  selections,
  models,
  options,
}) {
  const modelsFile = await readOptionalText(paths.pi.models);
  const modelsText = modelsFile.exists ? modelsFile.text : '{}\n';
  const modelsObject = modelsFile.exists
    ? parseStrictJsonObject(modelsText, paths.pi.models)
    : {};
  const modelsPrevious = findOwnershipEntry(state, 'pi', paths.pi.models);
  const plans = [
    createOwnedJsonPlan({
      client: 'pi',
      filePath: paths.pi.models,
      kind: 'json',
      exists: modelsFile.exists,
      currentText: modelsText,
      source: modelsObject,
      desiredValues: piModelsDesiredValues({ baseUrl, models }),
      previousEntry: modelsPrevious,
      force: options.force,
      jsonc: false,
    }),
  ];

  if (options.setDefault) {
    const settingsFile = await readOptionalText(paths.pi.settings);
    const settingsText = settingsFile.exists ? settingsFile.text : '{}\n';
    const settingsObject = settingsFile.exists
      ? parseStrictJsonObject(settingsText, paths.pi.settings)
      : {};
    const settingsPrevious = findOwnershipEntry(state, 'pi', paths.pi.settings);
    plans.push(createOwnedJsonPlan({
      client: 'pi',
      filePath: paths.pi.settings,
      kind: 'json',
      exists: settingsFile.exists,
      currentText: settingsText,
      source: settingsObject,
      desiredValues: piSettingsDesiredValues({
        defaultModel: selections.defaultModel,
      }),
      previousEntry: settingsPrevious,
      force: options.force,
      jsonc: false,
    }));
  }
  return plans;
}

async function buildConfigurationPlans({
  paths,
  state,
  catalog,
  config,
  options,
  preferences = {},
}) {
  const baseUrl = `http://127.0.0.1:${config.listen.port}`;
  const selections = selectClientModels(catalog, options, preferences);
  const plans = [];

  for (const client of options.clients) {
    if (client === 'claude') {
      plans.push(await planClaude({
        paths,
        state,
        baseUrl,
        selections,
        models: catalog.models,
        options,
      }));
    } else if (client === 'codex') {
      plans.push(await planCodex({
        paths,
        state,
        baseUrl,
        selections,
        options,
      }));
    } else if (client === 'opencode') {
      plans.push(await planOpenCode({
        paths,
        state,
        baseUrl,
        selections,
        models: catalog.models,
        options,
      }));
    } else if (client === 'pi') {
      plans.push(...await planPi({
        paths,
        state,
        baseUrl,
        selections,
        models: catalog.models,
        options,
      }));
    }
  }
  return { plans, selections };
}

async function defaultExecutableResolver(name, env = process.env) {
  const pathValue = env.PATH ?? env.Path ?? env.path ?? '';
  const directories = pathValue.split(path.delimiter).filter(Boolean);
  const hasExtension = path.extname(name).length > 0;
  const extensions = hasExtension
    ? ['']
    : process.platform === 'win32'
      ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      try {
        await access(
          candidate,
          process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK,
        );
        return true;
      } catch {
        // Continue searching.
      }
    }
  }
  return false;
}

async function configurationReports(plans, clients, executableResolver, env) {
  const reports = [];
  for (const client of clients) {
    const installed = await executableResolver(EXECUTABLE_NAMES[client], env);
    const clientPlans = plans.filter((plan) => plan.client === client);
    reports.push({
      client,
      configuration: 'generated',
      installation: installed ? 'installed' : 'not-installed',
      files: clientPlans.map((plan) => ({
        path: plan.path,
        change: plan.action,
        ...(plan.defaultSkipped ? { default: 'preserved-existing' } : {}),
      })),
    });
  }
  return reports;
}

function cleanupCreatedContainers(work, createdContainers, changes) {
  const sorted = [...createdContainers].toSorted((left, right) => right.length - left.length);
  for (const containerPath of sorted) {
    const state = getJsonPathState(work, containerPath);
    if (
      state.present
      && isPlainObject(state.value)
      && Object.keys(state.value).length === 0
    ) {
      deleteJsonPath(work, containerPath);
      changes.push({ path: containerPath, value: undefined });
    }
  }
}

function removalEntryOrNull(entry, { ownedPaths, managedBlocks, nextText }) {
  if (ownedPaths.length === 0 && managedBlocks.length === 0) {
    return null;
  }
  return {
    ...cloneJson(entry),
    wholeFileOwned: false,
    appliedFileHash: sha256Hex(nextText),
    ownedPaths,
    createdContainers: ownedPaths.length > 0
      ? cloneJson(entry.createdContainers)
      : [],
    managedBlocks,
  };
}

function planOwnedJsonRemoval(client, entry, currentText) {
  const strict = entry.kind === 'json';
  const source = strict
    ? parseStrictJsonObject(currentText, entry.path)
    : parseJsoncObject(currentText, entry.path);
  const work = cloneJson(source);
  const changes = [];
  const remaining = [];
  const conflicts = [];

  for (const owned of entry.ownedPaths) {
    const current = getJsonPathState(source, owned.path);
    if (!current.present) {
      continue;
    }
    if (owned.mode === 'array-member') {
      if (!Array.isArray(current.value)) {
        remaining.push(cloneJson(owned));
        conflicts.push(`Managed value "${pathLabel(owned.path)}" is no longer an array.`);
        continue;
      }
      const occurrences = current.value.filter((item) => item === owned.member).length;
      if (occurrences === 0) {
        continue;
      }
      if (occurrences !== 1) {
        remaining.push(cloneJson(owned));
        conflicts.push(`Managed array member "${owned.member}" is duplicated in "${pathLabel(owned.path)}".`);
        continue;
      }
      const next = current.value.filter((item) => item !== owned.member);
      setJsonPath(work, owned.path, next);
      changes.push({ path: owned.path, value: cloneJson(next) });
      continue;
    }
    if (!valuesEqual(current.value, owned.applied)) {
      remaining.push(cloneJson(owned));
      conflicts.push(`Managed value "${pathLabel(owned.path)}" was changed after configuration.`);
      continue;
    }

    if (owned.original.present) {
      setJsonPath(work, owned.path, owned.original.value);
      changes.push({ path: owned.path, value: cloneJson(owned.original.value) });
    } else {
      deleteJsonPath(work, owned.path);
      changes.push({ path: owned.path, value: undefined });
    }
  }

  cleanupCreatedContainers(work, entry.createdContainers, changes);
  let nextText = currentText;
  if (changes.length > 0) {
    nextText = entry.kind === 'jsonc'
      ? applyJsoncChanges(currentText, changes)
      : stringifyJsonLike(work, currentText, false);
  }
  const nextEntry = removalEntryOrNull(entry, {
    ownedPaths: remaining,
    managedBlocks: cloneJson(entry.managedBlocks),
    nextText,
  });
  return {
    client,
    path: entry.path,
    kind: entry.kind,
    exists: true,
    currentText,
    nextText,
    entry: nextEntry,
    action: nextText === currentText
      ? conflicts.length > 0 ? 'conflict' : 'unchanged'
      : 'restore',
    conflicts,
  };
}

function markerRangeForOwnedBlock(text, block) {
  return locateMarkerBlock(text, block.beginMarker, block.endMarker, block.name);
}

function planCodexRemoval(client, entry, currentText) {
  let output = currentText;
  const remaining = [];
  const conflicts = [];

  for (const block of [...entry.managedBlocks].reverse()) {
    const range = markerRangeForOwnedBlock(output, block);
    if (range === null) {
      continue;
    }
    if (range.text !== block.appliedText) {
      remaining.push(cloneJson(block));
      conflicts.push(`Managed Codex ${block.name} block was changed after configuration.`);
      continue;
    }
    const replacement = block.original.present ? block.original.text : '';
    let managedStart = range.start;
    let managedEnd = range.end;
    const leadingText = block.leadingText ?? '';
    const trailingText = block.trailingText ?? '';
    if (
      leadingText.length > 0
      && output.slice(managedStart - leadingText.length, managedStart) === leadingText
    ) {
      managedStart -= leadingText.length;
    }
    if (
      trailingText.length > 0
      && output.slice(managedEnd, managedEnd + trailingText.length) === trailingText
    ) {
      managedEnd += trailingText.length;
    }
    output = replaceTextRange(output, {
      start: managedStart,
      end: managedEnd,
    }, replacement);
  }

  const nextEntry = removalEntryOrNull(entry, {
    ownedPaths: cloneJson(entry.ownedPaths),
    managedBlocks: remaining,
    nextText: output,
  });
  return {
    client,
    path: entry.path,
    kind: entry.kind,
    exists: true,
    currentText,
    nextText: output,
    entry: nextEntry,
    action: output === currentText
      ? conflicts.length > 0 ? 'conflict' : 'unchanged'
      : 'restore',
    conflicts,
  };
}

async function planRemovalEntry(client, entry) {
  const current = await readOptionalText(entry.path);
  if (!current.exists) {
    return {
      client,
      path: entry.path,
      kind: entry.kind,
      exists: false,
      currentText: null,
      nextText: null,
      entry: null,
      action: 'already-missing',
      conflicts: [],
    };
  }

  if (
    entry.createdByGateway
    && entry.wholeFileOwned
    && sha256Hex(current.text) === entry.appliedFileHash
  ) {
    return {
      client,
      path: entry.path,
      kind: entry.kind,
      exists: true,
      currentText: current.text,
      nextText: null,
      entry: null,
      action: 'delete',
      conflicts: [],
    };
  }

  return entry.kind === 'toml-markers'
    ? planCodexRemoval(client, entry, current.text)
    : planOwnedJsonRemoval(client, entry, current.text);
}

async function buildRemovalPlans(state, clients) {
  const plans = [];
  for (const client of clients) {
    for (const entry of clientOwnershipFiles(state, client)) {
      plans.push(await planRemovalEntry(client, entry));
    }
  }
  return plans;
}

function removalReports(plans, clients) {
  return clients.map((client) => {
    const files = plans
      .filter((plan) => plan.client === client)
      .map((plan) => ({
        path: plan.path,
        change: plan.action,
        ...(plan.conflicts.length > 0 ? { conflicts: [...plan.conflicts] } : {}),
      }));
    return {
      client,
      configuration: files.length === 0 ? 'not-owned' : 'removal-planned',
      files,
    };
  });
}

async function writeOwnershipState(info, state, expectedText) {
  const nextText = serializeJson(state);
  if (nextText === expectedText) {
    return expectedText;
  }
  await atomicWriteJson(info.path, state, {
    expectedContent: expectedText,
  });
  return nextText;
}

async function applyConfigurationPlans(plans, ownershipInfo, backupNow) {
  const state = cloneJson(ownershipInfo.state);
  let expectedStateText = ownershipInfo.text;

  for (const plan of plans) {
    const result = await atomicWriteFile(plan.path, plan.nextText, {
      backup: true,
      expectedContent: plan.currentText,
      now: backupNow,
    });
    const entry = cloneJson(plan.entry);
    if (result.backupPath !== null) {
      entry.backupPath = result.backupPath;
    }
    setOwnershipEntry(state, plan.client, entry);
    expectedStateText = await writeOwnershipState(
      ownershipInfo,
      state,
      expectedStateText,
    );
  }
  return state;
}

async function applyRemovalPlans(plans, ownershipInfo, backupNow) {
  const state = cloneJson(ownershipInfo.state);
  let expectedStateText = ownershipInfo.text;

  for (const plan of plans) {
    if (plan.exists && plan.nextText === null) {
      await atomicRemoveFile(plan.path, {
        backup: true,
        expectedContent: plan.currentText,
        now: backupNow,
      });
    } else if (plan.exists) {
      await atomicWriteFile(plan.path, plan.nextText, {
        backup: true,
        expectedContent: plan.currentText,
        now: backupNow,
      });
    }

    if (plan.entry === null) {
      removeOwnershipEntry(state, plan.client, plan.path);
    } else {
      setOwnershipEntry(state, plan.client, plan.entry);
    }
    expectedStateText = await writeOwnershipState(
      ownershipInfo,
      state,
      expectedStateText,
    );
  }
  return state;
}

function emitJson(stdout, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (typeof stdout === 'function') {
    stdout(text);
  } else {
    stdout.write(text);
  }
}

export async function runConfigureClients(
  options,
  {
    env = process.env,
    fetchImpl = globalThis.fetch,
    now = () => new Date(),
    backupNow = now,
    stdout = process.stdout,
    executableResolver = defaultExecutableResolver,
  } = {},
) {
  const paths = resolveClientPaths({
    home: options.home,
    env,
    useEnvironmentOverrides: options.home === undefined,
  });
  const ownershipInfo = await readOwnershipState(options.root);

  if (options.remove) {
    const plans = await buildRemovalPlans(ownershipInfo.state, options.clients);
    const output = {
      action: 'remove',
      dryRun: options.dryRun,
      clients: removalReports(plans, options.clients),
    };
    if (!options.dryRun) {
      await applyRemovalPlans(plans, ownershipInfo, backupNow);
    }
    emitJson(stdout, output);
    return output;
  }

  const loaded = await loadModelCatalog({
    root: options.root,
    modelsFile: options.modelsFile,
    timeoutMs: options.timeoutMs,
    fetchImpl,
    now,
    writeCache: false,
    allowFreshCacheFallback: options.modelsFile === undefined,
  });
  const preferences = await readClientPreferences(options.root);
  const built = await buildConfigurationPlans({
    paths,
    state: ownershipInfo.state,
    catalog: loaded.catalog,
    config: loaded.config,
    options,
    preferences,
  });
  const reports = await configurationReports(
    built.plans,
    options.clients,
    executableResolver,
    env,
  );
  const output = {
    action: 'configure',
    dryRun: options.dryRun,
    models: {
      default: built.selections.defaultModel,
      claude: built.selections.claudeModel,
      opus: built.selections.opusModel,
      sonnet: built.selections.sonnetModel,
      codex: built.selections.codexModel,
      fast: built.selections.fastModel,
    },
    effort: {
      claude: built.selections.claudeEffort ?? 'default',
      codex: built.selections.codexEffort ?? 'default',
    },
    clients: reports,
  };

  if (!options.dryRun) {
    await writeModelCache(options.root, loaded.catalog);
    await applyConfigurationPlans(built.plans, ownershipInfo, backupNow);
    await writeClientPreferences(options.root, mergeClientPreferences(preferences, options));
  }
  emitJson(stdout, output);
  return output;
}

function clientPreferencesPath(root) {
  return path.join(root, 'state', 'client-preferences.json');
}

export async function readClientPreferences(root) {
  let value;
  try {
    value = JSON.parse(await readFile(clientPreferencesPath(root), 'utf8'));
  } catch {
    // Absent or unreadable preferences mean "use the product defaults".
    return {};
  }
  if (!isPlainObject(value)) {
    return {};
  }
  const preferences = {};
  for (const key of PREFERENCE_KEYS) {
    if (typeof value[key] === 'string' && value[key].length > 0) {
      preferences[key] = value[key];
    }
  }
  return preferences;
}

/** Explicit choices replace saved ones; anything not given is kept. */
export function mergeClientPreferences(previous, options) {
  const next = { ...previous };
  for (const key of PREFERENCE_KEYS) {
    if (options[key] !== undefined) {
      next[key] = options[key];
    }
  }
  return next;
}

async function writeClientPreferences(root, preferences) {
  const unchanged = await readClientPreferences(root);
  if (canonicalJson(unchanged) === canonicalJson(preferences)) {
    return;
  }
  await atomicWriteJson(clientPreferencesPath(root), {
    schemaVersion: 1,
    ...preferences,
  });
}

export function isConfigureClientsMain(moduleUrl = import.meta.url, argv1 = process.argv[1]) {
  return typeof argv1 === 'string'
    && pathToFileURL(path.resolve(argv1)).href === moduleUrl;
}

async function main() {
  try {
    const options = parseConfigureClientsArgs(process.argv.slice(2));
    await runConfigureClients(options);
  } catch (error) {
    process.stderr.write(`Error: ${error?.message ?? 'Client configuration failed.'}\n`);
    process.exitCode = 1;
  }
}

if (isConfigureClientsMain()) {
  void main();
}
