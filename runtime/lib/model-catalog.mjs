import { isIP } from 'node:net';
import path from 'node:path';

import {
  atomicWriteJson,
  readJsonFile,
  readTextFile,
  sha256Hex,
} from './atomic-files.mjs';

export const MODEL_CACHE_SCHEMA_VERSION = 1;
export const DEFAULT_MODEL_REFRESH_TTL_SECONDS = 900;
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000;
export const MIN_DISCOVERY_TIMEOUT_MS = 100;
export const MAX_DISCOVERY_TIMEOUT_MS = 120_000;
export const MAX_MODELS_RESPONSE_BYTES = 16 * 1024 * 1024;
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/;
export const ALIAS_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

const SENSITIVE_MODEL_FIELD_PATTERN =
  /api.?key|authorization|credential|secret|token|prompt|instruction|messages?|content/i;
const SAFE_METADATA_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

export class ModelCatalogError extends Error {
  constructor(message, code = 'MODEL_CATALOG_ERROR', options = undefined) {
    super(message, options);
    this.name = 'ModelCatalogError';
    this.code = code;
  }
}

export class ModelAliasTargetError extends ModelCatalogError {
  constructor(alias, modelId) {
    super(
      `Explicit model alias "${alias}" targets unavailable model "${modelId}". Update or remove that alias explicitly.`,
      'MODEL_ALIAS_TARGET_MISSING',
    );
    this.name = 'ModelAliasTargetError';
    this.alias = alias;
    this.modelId = modelId;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJsonValue(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export function validateModelId(modelId, label = 'model ID') {
  if (typeof modelId !== 'string' || !MODEL_ID_PATTERN.test(modelId)) {
    throw new ModelCatalogError(
      `${label} must be 1-256 safe ASCII characters and may contain letters, digits, ".", "_", ":", "/", "+", or "-".`,
      'INVALID_MODEL_ID',
    );
  }
  return modelId;
}

export function validateAliasName(alias) {
  if (typeof alias !== 'string' || !ALIAS_NAME_PATTERN.test(alias)) {
    throw new ModelCatalogError(
      'Alias names must begin with a letter and contain at most 64 letters, digits, ".", "_", or "-".',
      'INVALID_ALIAS_NAME',
    );
  }
  return alias;
}

export function normalizeDiscoveryTimeout(value) {
  const timeout = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)
      ? Number(value)
      : Number.NaN;

  if (
    !Number.isSafeInteger(timeout)
    || timeout < MIN_DISCOVERY_TIMEOUT_MS
    || timeout > MAX_DISCOVERY_TIMEOUT_MS
  ) {
    throw new ModelCatalogError(
      `Discovery timeout must be an integer from ${MIN_DISCOVERY_TIMEOUT_MS} through ${MAX_DISCOVERY_TIMEOUT_MS} milliseconds.`,
      'INVALID_DISCOVERY_TIMEOUT',
    );
  }
  return timeout;
}

export function isLoopbackAddress(address) {
  if (typeof address !== 'string') {
    return false;
  }

  const normalized = address.trim().toLowerCase();
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') {
    return true;
  }
  if (isIP(normalized) !== 4) {
    return false;
  }
  return normalized.split('.')[0] === '127';
}

function validateExplicitAliases(aliases) {
  if (!isPlainObject(aliases)) {
    throw new ModelCatalogError(
      'gateway.json models.aliases must be a JSON object.',
      'INVALID_GATEWAY_CONFIG',
    );
  }

  const result = {};
  for (const [alias, modelId] of Object.entries(aliases)) {
    validateAliasName(alias);
    validateModelId(modelId, `Target for alias "${alias}"`);
    result[alias] = modelId;
  }
  return result;
}

export function validateGatewayConfig(value, source = 'gateway.json') {
  if (!isPlainObject(value)) {
    throw new ModelCatalogError(`${source} must contain a JSON object.`, 'INVALID_GATEWAY_CONFIG');
  }
  if (value.schemaVersion !== 1) {
    throw new ModelCatalogError(
      `${source} schemaVersion must be 1.`,
      'INVALID_GATEWAY_CONFIG',
    );
  }
  if (!isPlainObject(value.listen)) {
    throw new ModelCatalogError(
      `${source} listen must be a JSON object.`,
      'INVALID_GATEWAY_CONFIG',
    );
  }
  if (value.listen.address.trim() !== '127.0.0.1') {
    throw new ModelCatalogError(
      `${source} listen.address must be exactly 127.0.0.1; other listeners are refused.`,
      'NON_LOOPBACK_LISTENER',
    );
  }
  if (
    !Number.isSafeInteger(value.listen.port)
    || value.listen.port < 1024
    || value.listen.port > 65_535
  ) {
    throw new ModelCatalogError(
      `${source} listen.port must be an integer from 1024 through 65535.`,
      'INVALID_GATEWAY_CONFIG',
    );
  }
  if (!isPlainObject(value.models)) {
    throw new ModelCatalogError(
      `${source} models must be a JSON object.`,
      'INVALID_GATEWAY_CONFIG',
    );
  }

  const ttl = value.models.refreshTtlSeconds ?? DEFAULT_MODEL_REFRESH_TTL_SECONDS;
  if (!Number.isSafeInteger(ttl) || ttl < 0 || ttl > 604_800) {
    throw new ModelCatalogError(
      `${source} models.refreshTtlSeconds must be an integer from 0 through 604800.`,
      'INVALID_GATEWAY_CONFIG',
    );
  }

  return {
    ...cloneJsonValue(value),
    listen: {
      ...cloneJsonValue(value.listen),
      address: value.listen.address.trim(),
      port: value.listen.port,
    },
    models: {
      ...cloneJsonValue(value.models),
      refreshTtlSeconds: ttl,
      aliases: validateExplicitAliases(value.models.aliases ?? {}),
    },
  };
}

export function catalogPaths(root) {
  const resolvedRoot = path.resolve(root);
  return {
    root: resolvedRoot,
    gatewayConfig: path.join(resolvedRoot, 'config', 'gateway.json'),
    secrets: path.join(resolvedRoot, 'secrets', 'secrets.json'),
    cache: path.join(resolvedRoot, 'state', 'models.json'),
  };
}

export async function readGatewayConfig(root) {
  const paths = catalogPaths(root);
  const value = await readJsonFile(paths.gatewayConfig, {
    required: true,
    label: 'gateway configuration',
  });
  return validateGatewayConfig(value, paths.gatewayConfig);
}

function sanitizeMetadataValue(value, depth, seen) {
  if (value === null || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string') {
    if (value.length > 4096 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) {
      return undefined;
    }
    return value;
  }
  if (depth >= 5 || typeof value !== 'object' || value === null || seen.has(value)) {
    return undefined;
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > 256) {
        return undefined;
      }
      const result = [];
      for (const item of value) {
        const sanitized = sanitizeMetadataValue(item, depth + 1, seen);
        if (sanitized !== undefined) {
          result.push(sanitized);
        }
      }
      return result;
    }

    if (!isPlainObject(value)) {
      return undefined;
    }
    const result = {};
    for (const [key, nested] of Object.entries(value)) {
      if (
        !SAFE_METADATA_KEY_PATTERN.test(key)
        || SENSITIVE_MODEL_FIELD_PATTERN.test(key)
      ) {
        continue;
      }
      const sanitized = sanitizeMetadataValue(nested, depth + 1, seen);
      if (sanitized !== undefined) {
        result[key] = sanitized;
      }
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

export function sanitizeModelMetadata(model) {
  if (!isPlainObject(model)) {
    throw new ModelCatalogError(
      'Every /v1/models data entry must be a JSON object.',
      'INVALID_MODELS_RESPONSE',
    );
  }
  const id = validateModelId(model.id, 'Every /v1/models data entry id');
  const sanitized = { id };
  const seen = new WeakSet([model]);

  for (const [key, value] of Object.entries(model)) {
    if (
      key === 'id'
      || !SAFE_METADATA_KEY_PATTERN.test(key)
      || SENSITIVE_MODEL_FIELD_PATTERN.test(key)
    ) {
      continue;
    }
    const safeValue = sanitizeMetadataValue(value, 1, seen);
    if (safeValue !== undefined) {
      sanitized[key] = safeValue;
    }
  }
  return sanitized;
}

function compareCodePoints(left, right) {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function naturalTokens(value) {
  return value.toLowerCase().match(/\d+|\D+/g) ?? [];
}

export function compareModelIds(left, right) {
  const leftTokens = naturalTokens(left);
  const rightTokens = naturalTokens(right);
  const count = Math.max(leftTokens.length, rightTokens.length);

  for (let index = 0; index < count; index += 1) {
    if (leftTokens[index] === undefined) {
      return -1;
    }
    if (rightTokens[index] === undefined) {
      return 1;
    }
    const leftToken = leftTokens[index];
    const rightToken = rightTokens[index];
    if (leftToken === rightToken) {
      continue;
    }

    const bothNumeric = /^\d+$/.test(leftToken) && /^\d+$/.test(rightToken);
    if (bothNumeric) {
      const normalizedLeft = leftToken.replace(/^0+(?=\d)/, '');
      const normalizedRight = rightToken.replace(/^0+(?=\d)/, '');
      if (normalizedLeft.length !== normalizedRight.length) {
        return normalizedLeft.length - normalizedRight.length;
      }
      const numericComparison = compareCodePoints(normalizedLeft, normalizedRight);
      if (numericComparison !== 0) {
        return numericComparison;
      }
    } else {
      const tokenComparison = compareCodePoints(leftToken, rightToken);
      if (tokenComparison !== 0) {
        return tokenComparison;
      }
    }
  }
  return compareCodePoints(left, right);
}

function newestMatching(ids, predicates) {
  for (const predicate of predicates) {
    const candidates = ids.filter((id) => predicate(id.toLowerCase()));
    if (candidates.length > 0) {
      return candidates.toSorted(compareModelIds).at(-1);
    }
  }
  return undefined;
}

export function buildAliases(modelIds, explicitAliases = {}) {
  if (!Array.isArray(modelIds) || modelIds.length === 0) {
    throw new ModelCatalogError(
      'At least one discovered model is required to build aliases.',
      'NO_MODELS_DISCOVERED',
    );
  }

  const uniqueIds = [];
  const seen = new Set();
  for (const modelId of modelIds) {
    validateModelId(modelId);
    if (!seen.has(modelId)) {
      seen.add(modelId);
      uniqueIds.push(modelId);
    }
  }
  const deterministicIds = uniqueIds.toSorted(compareCodePoints);

  const claude = newestMatching(deterministicIds, [
    (id) => id.includes('claude') && id.includes('sonnet'),
    (id) => id.includes('claude') && id.includes('opus'),
    (id) => id.includes('claude'),
  ]);
  const codex = newestMatching(deterministicIds, [
    (id) => id.includes('codex'),
    (id) => /(?:^|[/_.:+-])gpt(?:$|[/_.:+-]|\d)/.test(id),
  ]);
  const fast = newestMatching(deterministicIds, [
    (id) => id.includes('haiku'),
    (id) => id.includes('luna'),
    (id) => id.includes('mini'),
    (id) => id.includes('flash'),
  ]);
  const defaultModel = claude ?? codex ?? deterministicIds[0];

  const aliases = {
    default: defaultModel,
  };
  if (claude !== undefined) {
    aliases.claude = claude;
  }
  if (codex !== undefined) {
    aliases.codex = codex;
  }
  aliases.fast = fast ?? defaultModel;

  const normalizedExplicit = validateExplicitAliases(explicitAliases);
  for (const [alias, target] of Object.entries(normalizedExplicit)) {
    if (!seen.has(target)) {
      throw new ModelAliasTargetError(alias, target);
    }
    aliases[alias] = target;
  }
  return aliases;
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (isPlainObject(value)) {
    const result = {};
    for (const key of Object.keys(value).toSorted(compareCodePoints)) {
      result[key] = canonicalize(value[key]);
    }
    return result;
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function safeBackendVersion(value) {
  if (
    typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._/+:-]{0,127}$/.test(value)
  ) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function backendVersionFrom(payload, headers) {
  const bodyVersion = safeBackendVersion(payload.backendVersion ?? payload.version);
  if (bodyVersion !== null) {
    return bodyVersion;
  }
  if (!headers || typeof headers.get !== 'function') {
    return null;
  }
  return safeBackendVersion(
    headers.get('x-backend-version')
      ?? headers.get('x-copilot-api-version')
      ?? headers.get('server'),
  );
}

function modelsArrayFromPayload(payload) {
  if (!isPlainObject(payload)) {
    throw new ModelCatalogError(
      '/v1/models must return a JSON object.',
      'INVALID_MODELS_RESPONSE',
    );
  }
  if (Array.isArray(payload.data)) {
    return payload.data;
  }
  throw new ModelCatalogError(
    '/v1/models must return an object with a data array.',
    'INVALID_MODELS_RESPONSE',
  );
}

export function createCatalogFromPayload(
  payload,
  {
    explicitAliases = {},
    rawResponse = undefined,
    headers = undefined,
    now = () => new Date(),
  } = {},
) {
  const rawModels = modelsArrayFromPayload(payload);
  const byId = new Map();
  for (const rawModel of rawModels) {
    const model = sanitizeModelMetadata(rawModel);
    if (!byId.has(model.id)) {
      byId.set(model.id, model);
    }
  }
  if (byId.size === 0) {
    throw new ModelCatalogError(
      '/v1/models returned no usable models.',
      'NO_MODELS_DISCOVERED',
    );
  }

  const models = [...byId.values()].toSorted((left, right) =>
    compareCodePoints(left.id, right.id));
  const aliases = buildAliases(models.map((model) => model.id), explicitAliases);
  const discovered = typeof now === 'function' ? now() : now;
  const discoveredAt = discovered instanceof Date ? discovered : new Date(discovered);
  if (Number.isNaN(discoveredAt.getTime())) {
    throw new TypeError('The model discovery clock seam returned an invalid date.');
  }

  const hashInput = rawResponse === undefined
    ? canonicalJson(payload)
    : rawResponse;
  return {
    schemaVersion: MODEL_CACHE_SCHEMA_VERSION,
    discoveredAt: discoveredAt.toISOString(),
    backendVersion: backendVersionFrom(payload, headers),
    responseHash: sha256Hex(hashInput),
    models,
    aliases,
  };
}

export function validateModelCache(value, source = 'models.json') {
  if (!isPlainObject(value) || value.schemaVersion !== MODEL_CACHE_SCHEMA_VERSION) {
    throw new ModelCatalogError(
      `${source} schemaVersion must be ${MODEL_CACHE_SCHEMA_VERSION}.`,
      'INVALID_MODEL_CACHE',
    );
  }
  if (
    typeof value.discoveredAt !== 'string'
    || Number.isNaN(Date.parse(value.discoveredAt))
  ) {
    throw new ModelCatalogError(
      `${source} discoveredAt must be a valid timestamp.`,
      'INVALID_MODEL_CACHE',
    );
  }
  if (
    value.backendVersion !== null
    && value.backendVersion !== undefined
    && safeBackendVersion(value.backendVersion) === null
  ) {
    throw new ModelCatalogError(
      `${source} backendVersion is invalid.`,
      'INVALID_MODEL_CACHE',
    );
  }
  if (typeof value.responseHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.responseHash)) {
    throw new ModelCatalogError(
      `${source} responseHash must be a SHA-256 hexadecimal digest.`,
      'INVALID_MODEL_CACHE',
    );
  }
  if (!Array.isArray(value.models) || value.models.length === 0) {
    throw new ModelCatalogError(
      `${source} models must be a non-empty array.`,
      'INVALID_MODEL_CACHE',
    );
  }

  const models = [];
  const ids = new Set();
  for (const item of value.models) {
    const model = sanitizeModelMetadata(item);
    if (ids.has(model.id)) {
      throw new ModelCatalogError(
        `${source} contains a duplicate model ID.`,
        'INVALID_MODEL_CACHE',
      );
    }
    ids.add(model.id);
    models.push(model);
  }
  models.sort((left, right) => compareCodePoints(left.id, right.id));

  if (!isPlainObject(value.aliases)) {
    throw new ModelCatalogError(
      `${source} aliases must be a JSON object.`,
      'INVALID_MODEL_CACHE',
    );
  }
  const aliases = {};
  for (const [alias, modelId] of Object.entries(value.aliases)) {
    validateAliasName(alias);
    validateModelId(modelId, `Target for cached alias "${alias}"`);
    if (!ids.has(modelId)) {
      throw new ModelCatalogError(
        `${source} alias "${alias}" targets a model that is not cached.`,
        'INVALID_MODEL_CACHE',
      );
    }
    aliases[alias] = modelId;
  }

  return {
    schemaVersion: MODEL_CACHE_SCHEMA_VERSION,
    discoveredAt: new Date(value.discoveredAt).toISOString(),
    backendVersion: safeBackendVersion(value.backendVersion) ?? null,
    responseHash: value.responseHash,
    models,
    aliases,
  };
}

export function isModelCacheFresh(catalog, ttlSeconds, now = new Date()) {
  const current = now instanceof Date ? now : new Date(now);
  const discoveredAt = Date.parse(catalog.discoveredAt);
  if (Number.isNaN(current.getTime()) || Number.isNaN(discoveredAt)) {
    return false;
  }
  const age = Math.max(0, current.getTime() - discoveredAt);
  return age <= ttlSeconds * 1000;
}

export async function readModelCache(root) {
  const cachePath = catalogPaths(root).cache;
  const value = await readJsonFile(cachePath, {
    required: false,
    label: 'model cache',
  });
  return value === null ? null : validateModelCache(value, cachePath);
}

function validateSecrets(value, source) {
  if (!isPlainObject(value)) {
    throw new ModelCatalogError(
      `${source} must contain a JSON object.`,
      'INVALID_SECRETS_FILE',
    );
  }
  if (
    typeof value.clientApiKey !== 'string'
    || value.clientApiKey.length === 0
    || value.clientApiKey.length > 4096
    || /[\r\n\u0000]/u.test(value.clientApiKey)
  ) {
    throw new ModelCatalogError(
      `${source} clientApiKey must be a non-empty single-line string.`,
      'INVALID_SECRETS_FILE',
    );
  }
  return value.clientApiKey;
}

async function parseFixture(modelsFile) {
  const text = await readTextFile(path.resolve(modelsFile), {
    required: true,
    label: 'models fixture',
  });
  try {
    return {
      payload: JSON.parse(text.startsWith('\uFEFF') ? text.slice(1) : text),
      rawResponse: text,
    };
  } catch (error) {
    throw new ModelCatalogError(
      `Models fixture "${path.resolve(modelsFile)}" is not valid JSON.`,
      'INVALID_MODELS_FIXTURE',
      { cause: error },
    );
  }
}

async function fetchModels({
  port,
  clientApiKey,
  timeoutMs,
  fetchImpl,
}) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ModelCatalogError(
        `Model discovery timed out after ${timeoutMs} milliseconds.`,
        'MODEL_DISCOVERY_TIMEOUT',
      ));
    }, timeoutMs);
  });

  const request = (async () => {
    const response = await fetchImpl(`http://127.0.0.1:${port}/v1/models`, {
      method: 'GET',
      redirect: 'error',
      headers: {
        'x-api-key': clientApiKey,
      },
      signal: controller.signal,
    });

    if (!response || typeof response.text !== 'function') {
      throw new ModelCatalogError(
        'The model-discovery transport returned an invalid response.',
        'MODEL_DISCOVERY_REQUEST_FAILED',
      );
    }
    if (!response.ok) {
      const status = Number.isInteger(response.status) ? response.status : 'unknown';
      throw new ModelCatalogError(
        `The loopback model-discovery endpoint returned HTTP ${status}.`,
        'MODEL_DISCOVERY_HTTP_ERROR',
      );
    }

    const contentLength = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_MODELS_RESPONSE_BYTES) {
      throw new ModelCatalogError(
        'The model-discovery response exceeded the size limit.',
        'MODEL_DISCOVERY_RESPONSE_TOO_LARGE',
      );
    }
    const rawResponse = await response.text();
    if (Buffer.byteLength(rawResponse, 'utf8') > MAX_MODELS_RESPONSE_BYTES) {
      throw new ModelCatalogError(
        'The model-discovery response exceeded the size limit.',
        'MODEL_DISCOVERY_RESPONSE_TOO_LARGE',
      );
    }

    let payload;
    try {
      payload = JSON.parse(
        rawResponse.startsWith('\uFEFF') ? rawResponse.slice(1) : rawResponse,
      );
    } catch (error) {
      throw new ModelCatalogError(
        'The loopback model-discovery endpoint returned invalid JSON.',
        'INVALID_MODELS_RESPONSE',
        { cause: error },
      );
    }
    return { payload, rawResponse, headers: response.headers };
  })();

  try {
    return await Promise.race([request, timeout]);
  } catch (error) {
    if (error instanceof ModelCatalogError) {
      throw error;
    }
    if (controller.signal.aborted || error?.name === 'AbortError') {
      throw new ModelCatalogError(
        `Model discovery timed out after ${timeoutMs} milliseconds.`,
        'MODEL_DISCOVERY_TIMEOUT',
      );
    }
    throw new ModelCatalogError(
      'Unable to contact the loopback model-discovery endpoint.',
      'MODEL_DISCOVERY_REQUEST_FAILED',
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function discoverModels({
  root,
  modelsFile = undefined,
  timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  config: suppliedConfig = undefined,
  explicitAliases = undefined,
} = {}) {
  if (typeof root !== 'string' || root.length === 0) {
    throw new ModelCatalogError('A root directory is required for model discovery.', 'ROOT_REQUIRED');
  }
  const config = suppliedConfig === undefined
    ? await readGatewayConfig(root)
    : validateGatewayConfig(suppliedConfig, 'gateway configuration');
  const normalizedTimeout = normalizeDiscoveryTimeout(timeoutMs);
  const aliases = explicitAliases ?? config.models.aliases;

  let result;
  if (modelsFile !== undefined) {
    result = await parseFixture(modelsFile);
  } else {
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('fetchImpl must be a function.');
    }
    const secretPath = catalogPaths(root).secrets;
    const secrets = await readJsonFile(secretPath, {
      required: true,
      label: 'gateway secrets',
    });
    const clientApiKey = validateSecrets(secrets, secretPath);
    result = await fetchModels({
      port: config.listen.port,
      clientApiKey,
      timeoutMs: normalizedTimeout,
      fetchImpl,
    });
  }

  return createCatalogFromPayload(result.payload, {
    explicitAliases: aliases,
    rawResponse: result.rawResponse,
    headers: result.headers,
    now,
  });
}

export async function writeModelCache(root, catalog, options = {}) {
  const validated = validateModelCache(catalog, 'model catalog');
  return atomicWriteJson(catalogPaths(root).cache, validated, options);
}

function sameAliases(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function reconcileCacheAliases(catalog, explicitAliases) {
  const aliases = buildAliases(
    catalog.models.map((model) => model.id),
    explicitAliases,
  );
  if (sameAliases(aliases, catalog.aliases)) {
    return { catalog, changed: false };
  }
  return {
    catalog: {
      ...catalog,
      aliases,
    },
    changed: true,
  };
}

export async function loadModelCatalog({
  root,
  modelsFile = undefined,
  timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  forceRefresh = false,
  allowFreshCacheFallback = true,
  writeCache = true,
  explicitAliases = undefined,
} = {}) {
  const config = await readGatewayConfig(root);
  const aliases = explicitAliases ?? config.models.aliases;
  const clockValue = typeof now === 'function' ? now() : now;
  const clock = clockValue instanceof Date ? clockValue : new Date(clockValue);
  if (Number.isNaN(clock.getTime())) {
    throw new TypeError('The model catalog clock seam returned an invalid date.');
  }

  let cache = null;
  let cacheError = null;
  try {
    cache = await readModelCache(root);
  } catch (error) {
    cacheError = error;
  }

  const cacheIsFresh = cache !== null
    && isModelCacheFresh(cache, config.models.refreshTtlSeconds, clock);
  if (cacheIsFresh && !forceRefresh && modelsFile === undefined) {
    const reconciled = reconcileCacheAliases(cache, aliases);
    if (reconciled.changed && writeCache) {
      await writeModelCache(root, reconciled.catalog);
    }
    return {
      catalog: reconciled.catalog,
      config,
      source: 'cache',
      refreshed: false,
      refreshError: null,
    };
  }

  try {
    const catalog = await discoverModels({
      root,
      modelsFile,
      timeoutMs,
      fetchImpl,
      now: () => new Date(clock),
      config,
      explicitAliases: aliases,
    });
    if (writeCache) {
      await writeModelCache(root, catalog);
    }
    return {
      catalog,
      config,
      source: modelsFile === undefined ? 'network' : 'fixture',
      refreshed: true,
      refreshError: null,
    };
  } catch (error) {
    if (cacheIsFresh && allowFreshCacheFallback) {
      const reconciled = reconcileCacheAliases(cache, aliases);
      return {
        catalog: reconciled.catalog,
        config,
        source: 'cache',
        refreshed: false,
        refreshError: error,
      };
    }
    if (cacheError !== null && error?.cause === undefined) {
      error.cause = cacheError;
    }
    throw error;
  }
}
