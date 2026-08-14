import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { atomicWriteJson } from './lib/atomic-files.mjs';
import {
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  buildAliases,
  catalogPaths,
  loadModelCatalog,
  normalizeDiscoveryTimeout,
  readGatewayConfig,
  validateAliasName,
  validateModelId,
  writeModelCache,
} from './lib/model-catalog.mjs';

const ACTIONS = new Set(['list', 'refresh', 'set-alias']);
const VALUE_OPTIONS = new Map([
  ['--root', 'root'],
  ['--alias', 'alias'],
  ['--model', 'model'],
  ['--models-file', 'modelsFile'],
  ['--timeout-ms', 'timeoutMs'],
]);

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

export function parseModelsCliArgs(argv) {
  if (!Array.isArray(argv)) {
    throw new TypeError('CLI arguments must be an array.');
  }

  let action = null;
  const parsed = {};
  const seenOptions = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (typeof argument !== 'string' || argument.length === 0) {
      throw new Error('CLI arguments must be non-empty strings.');
    }

    if (!argument.startsWith('--')) {
      if (!ACTIONS.has(argument)) {
        throw new Error(`Unknown action "${argument}".`);
      }
      if (action !== null) {
        throw new Error('Only one action may be specified.');
      }
      action = argument;
      continue;
    }

    const { name, inlineValue } = splitLongOption(argument);
    const property = VALUE_OPTIONS.get(name);
    if (property === undefined) {
      throw new Error(`Unknown option "${name}".`);
    }
    if (seenOptions.has(name)) {
      throw new Error(`Option "${name}" may be specified only once.`);
    }
    seenOptions.add(name);
    const read = readOptionValue(argv, index, name, inlineValue);
    parsed[property] = read.value;
    index = read.nextIndex;
  }

  action ??= 'list';
  if (parsed.root === undefined) {
    throw new Error('--root is required.');
  }
  if (parsed.root.trim().length === 0) {
    throw new Error('--root requires a non-empty value.');
  }

  if (action === 'set-alias') {
    if (parsed.alias === undefined || parsed.model === undefined) {
      throw new Error('set-alias requires both --alias NAME and --model ID.');
    }
    validateAliasName(parsed.alias);
    validateModelId(parsed.model);
  } else if (parsed.alias !== undefined || parsed.model !== undefined) {
    throw new Error('--alias and --model are valid only with set-alias.');
  }

  return {
    action,
    root: path.resolve(parsed.root),
    alias: parsed.alias,
    model: parsed.model,
    modelsFile: parsed.modelsFile === undefined ? undefined : path.resolve(parsed.modelsFile),
    timeoutMs: parsed.timeoutMs === undefined
      ? DEFAULT_DISCOVERY_TIMEOUT_MS
      : normalizeDiscoveryTimeout(parsed.timeoutMs),
  };
}

export function safeCatalogOutput(catalog) {
  return {
    models: catalog.models.map((model) => model.id),
    aliases: { ...catalog.aliases },
  };
}

function emitJson(stdout, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (typeof stdout === 'function') {
    stdout(text);
    return;
  }
  stdout.write(text);
}

async function setAlias(options, dependencies) {
  const config = await readGatewayConfig(options.root);
  const explicitAliases = {
    ...config.models.aliases,
    [options.alias]: options.model,
  };

  const loaded = await loadModelCatalog({
    root: options.root,
    modelsFile: options.modelsFile,
    timeoutMs: options.timeoutMs,
    fetchImpl: dependencies.fetchImpl,
    now: dependencies.now,
    writeCache: false,
    explicitAliases,
  });

  const ids = new Set(loaded.catalog.models.map((model) => model.id));
  if (!ids.has(options.model)) {
    throw new Error(`Model "${options.model}" is not present in the discovered model catalog.`);
  }

  const nextConfig = {
    ...config,
    models: {
      ...config.models,
      aliases: explicitAliases,
    },
  };
  const nextCatalog = {
    ...loaded.catalog,
    aliases: buildAliases([...ids], explicitAliases),
  };

  await atomicWriteJson(catalogPaths(options.root).gatewayConfig, nextConfig, {
    backup: true,
    now: dependencies.backupNow,
  });
  await writeModelCache(options.root, nextCatalog);
  return nextCatalog;
}

export async function runModelsCli(
  options,
  {
    fetchImpl = globalThis.fetch,
    now = () => new Date(),
    backupNow = now,
    stdout = process.stdout,
  } = {},
) {
  let catalog;
  if (options.action === 'set-alias') {
    catalog = await setAlias(options, {
      fetchImpl,
      now,
      backupNow,
    });
  } else {
    const loaded = await loadModelCatalog({
      root: options.root,
      modelsFile: options.modelsFile,
      timeoutMs: options.timeoutMs,
      fetchImpl,
      now,
      forceRefresh: options.action === 'refresh',
      allowFreshCacheFallback: options.action === 'list',
      writeCache: true,
    });
    catalog = loaded.catalog;
  }

  const output = safeCatalogOutput(catalog);
  emitJson(stdout, output);
  return output;
}

export function isModelsCliMain(moduleUrl = import.meta.url, argv1 = process.argv[1]) {
  return typeof argv1 === 'string'
    && pathToFileURL(path.resolve(argv1)).href === moduleUrl;
}

async function main() {
  try {
    const options = parseModelsCliArgs(process.argv.slice(2));
    await runModelsCli(options);
  } catch (error) {
    process.stderr.write(`Error: ${error?.message ?? 'Model operation failed.'}\n`);
    process.exitCode = 1;
  }
}

if (isModelsCliMain()) {
  await main();
}
