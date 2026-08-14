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

export const CODEX_PROVIDER_BEGIN = '# >>> copilot-harness-gateway:provider >>>';
export const CODEX_PROVIDER_END = '# <<< copilot-harness-gateway:provider <<<';
export const CODEX_DEFAULTS_BEGIN = '# >>> copilot-harness-gateway:defaults >>>';
export const CODEX_DEFAULTS_END = '# <<< copilot-harness-gateway:defaults <<<';

const OWNERSHIP_SCHEMA_VERSION = 1;
const VALUE_OPTIONS = new Map([
  ['--root', 'root'],
  ['--clients', 'clients'],
  ['--home', 'home'],
  ['--model', 'model'],
  ['--claude-model', 'claudeModel'],
  ['--codex-model', 'codexModel'],
  ['--fast-model', 'fastModel'],
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

  for (const property of ['model', 'claudeModel', 'codexModel', 'fastModel']) {
    if (parsed[property] !== undefined) {
      validateModelId(parsed[property], `Value for --${property.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
    }
  }

  if (
    parsed.remove
    && (
      parsed.model !== undefined
      || parsed.claudeModel !== undefined
      || parsed.codexModel !== undefined
      || parsed.fastModel !== undefined
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
    codexModel: parsed.codexModel,
    fastModel: parsed.fastModel,
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

function makeOwnedPath(pathSegments, original, applied) {
  const originalRecord = { present: original.present };
  if (original.present) {
    originalRecord.value = cloneJson(original.value);
  }
  return {
    path: [...pathSegments],
    original: originalRecord,
    applied: cloneJson(applied),
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

  for (const desired of desiredValues) {
    const key = jsonPathKey(desired.path);
    desiredKeys.add(key);
    const current = getJsonPathState(source, desired.path);
    const previous = priorOwned.get(key);
    if (
      previous
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

    const original = previous?.original ?? current;
    nextOwned.push(makeOwnedPath(desired.path, original, desired.value));
    if (!current.present || !valuesEqual(current.value, desired.value)) {
      changes.push({ path: desired.path, value: cloneJson(desired.value) });
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

function createOwnedJsonPlan({
  client,
  filePath,
  kind,
  exists,
  currentText,
  source,
  desiredValues,
  previousEntry,
  force,
  jsonc,
}) {
  const prepared = prepareOwnedJsonChanges({
    source,
    desiredValues,
    previousEntry,
    force,
    filePath,
  });
  let nextText = currentText;
  if (prepared.changes.length > 0) {
    if (jsonc) {
      nextText = applyJsoncChanges(currentText, prepared.changes);
    } else {
      const nextObject = cloneJson(source);
      for (const change of prepared.changes) {
        setJsonPath(nextObject, change.path, change.value);
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

function claudeDesiredValues({
  baseUrl,
  claudeModel,
  sonnetModel = claudeModel,
  opusModel = claudeModel,
  fastModel,
  setDefault = false,
}) {
  const desired = [
    { path: ['apiKeyHelper'], value: CLAUDE_API_KEY_HELPER },
    { path: ['env', 'ANTHROPIC_BASE_URL'], value: baseUrl },
    { path: ['env', 'ANTHROPIC_DEFAULT_SONNET_MODEL'], value: sonnetModel },
    { path: ['env', 'ANTHROPIC_DEFAULT_OPUS_MODEL'], value: opusModel },
    { path: ['env', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'], value: fastModel },
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
  if (
    helper.present
    && helper.value !== CLAUDE_API_KEY_HELPER
    && options.force !== true
  ) {
    throw new Error('Claude Code already has a different apiKeyHelper; use --force to replace it.');
  }
  for (const desired of claudeDesiredValues(options)) {
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

function openCodeDesiredValues({
  baseUrl,
  models,
  defaultModel,
  fastModel,
  setDefault = false,
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
  return desired;
}

export function mergeOpenCodeJsonc(text, options) {
  const sourceText = text.length === 0 ? '{}\n' : text;
  const source = parseJsoncObject(sourceText, options.filePath ?? 'OpenCode configuration');
  const changes = [];
  for (const desired of openCodeDesiredValues(options)) {
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
    const match = line.content.match(/^\s*(model|model_provider)\s*=/);
    if (match) {
      found.add(match[1]);
    }
  }
  return found;
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

function codexDefaultsBlock(model, eol) {
  return [
    CODEX_DEFAULTS_BEGIN,
    `model_provider = ${JSON.stringify(CODEX_PROVIDER_ID)}`,
    `model = ${JSON.stringify(model)}`,
    CODEX_DEFAULTS_END,
  ].join(eol);
}

export function mergeCodexConfig(
  text,
  {
    baseUrl,
    model,
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
    checkManagedBlockConflict({
      current: initialProviderRange.text,
      desired: providerBlock,
      previous: providerPrevious,
      force,
      filePath,
      name: 'provider',
    });
    providerOriginal = providerPrevious?.original ?? { present: false };
    output = replaceTextRange(output, initialProviderRange, providerBlock);
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
    const defaultsBlock = codexDefaultsBlock(model, eol);
    const defaultsPrevious = previousManagedBlock(previousBlocks, 'defaults');
    const defaultsRange = codexMarkerRanges(output).defaults;
    const externalDefaults = externalCodexDefaults(output);
    if (defaultsRange) {
      if (externalDefaults.size > 0) {
        throw new Error(
          `Codex configuration "${filePath}" has conflicting managed and unmarked top-level model defaults.`,
        );
      }
      checkManagedBlockConflict({
        current: defaultsRange.text,
        desired: defaultsBlock,
        previous: defaultsPrevious,
        force,
        filePath,
        name: 'defaults',
      });
      output = replaceTextRange(output, defaultsRange, defaultsBlock);
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
    } else if (externalDefaults.size > 0) {
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

export function selectClientModels(catalog, options) {
  const ids = new Set(catalog.models.map((model) => model.id));
  for (const [optionName, modelId] of [
    ['--model', options.model],
    ['--claude-model', options.claudeModel],
    ['--codex-model', options.codexModel],
    ['--fast-model', options.fastModel],
  ]) {
    if (modelId !== undefined && !ids.has(modelId)) {
      throw new Error(`${optionName} selects model "${modelId}", which is not in the discovered catalog.`);
    }
  }

  const defaultModel = options.model ?? catalog.aliases.default;
  const claudeModel =
    options.claudeModel
    ?? options.model
    ?? catalog.aliases.claude
    ?? defaultModel;
  const codexModel =
    options.codexModel
    ?? options.model
    ?? catalog.aliases.codex
    ?? defaultModel;
  const fastModel =
    options.fastModel
    ?? options.model
    ?? catalog.aliases.fast
    ?? defaultModel;

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

  const explicitClaudeOverride = options.claudeModel !== undefined || options.model !== undefined;
  const sonnetModel = explicitClaudeOverride
    ? claudeModel
    : newestModel(
      catalog.models,
      (id) => id.includes('claude') && id.includes('sonnet'),
    ) ?? claudeModel;
  const opusModel = explicitClaudeOverride
    ? claudeModel
    : newestModel(
      catalog.models,
      (id) => id.includes('claude') && id.includes('opus'),
    ) ?? claudeModel;
  const claudeFastModel = isClaudeModel(fastModel)
    ? fastModel
    : newestModel(
      catalog.models,
      (id) => id.includes('claude') && id.includes('haiku'),
    ) ?? claudeModel;

  return {
    defaultModel,
    claudeModel,
    codexModel,
    fastModel,
    claudeFastModel,
    sonnetModel,
    opusModel,
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
    const previousHelper = previousEntry?.ownedPaths?.find(
      (owned) => jsonPathKey(owned.path) === jsonPathKey(['apiKeyHelper']),
    );
    if (
      existingHelper.present
      && existingHelper.value !== CLAUDE_API_KEY_HELPER
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

    return createOwnedJsonPlan({
      client: 'claude',
      filePath: paths.claude.settings,
      kind: 'json',
      exists: current.exists,
      currentText: sourceText,
      source,
      desiredValues: claudeDesiredValues({
        baseUrl,
        claudeModel: selections.claudeModel,
        sonnetModel: selections.sonnetModel,
        opusModel: selections.opusModel,
        fastModel: selections.claudeFastModel,
        setDefault: options.setDefault,
        models,
      }),
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
}) {
  const baseUrl = `http://127.0.0.1:${config.listen.port}`;
  const selections = selectClientModels(catalog, options);
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
  const built = await buildConfigurationPlans({
    paths,
    state: ownershipInfo.state,
    catalog: loaded.catalog,
    config: loaded.config,
    options,
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
      codex: built.selections.codexModel,
      fast: built.selections.fastModel,
    },
    clients: reports,
  };

  if (!options.dryRun) {
    await writeModelCache(options.root, loaded.catalog);
    await applyConfigurationPlans(built.plans, ownershipInfo, backupNow);
  }
  emitJson(stdout, output);
  return output;
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
  await main();
}
