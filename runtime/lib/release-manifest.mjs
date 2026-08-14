import { createHash, verify } from 'node:crypto';

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const ASSET = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CHANNELS = new Set(['stable', 'beta']);
const PLATFORMS = new Set(['win32', 'darwin', 'linux']);
const ARCHES = new Set(['x64', 'arm64']);
const FORMATS = new Set(['nsis', 'dmg', 'zip', 'appimage', 'deb']);

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (object(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} must be an integer of at least ${minimum}.`);
  }
}

function validateAsset(asset, index) {
  if (!object(asset) || !ASSET.test(asset.name ?? '')) {
    throw new Error(`assets[${index}] is invalid.`);
  }
  if (!PLATFORMS.has(asset.platform) || !ARCHES.has(asset.arch)) {
    throw new Error(`assets[${index}] target is unsupported.`);
  }
  if (!FORMATS.has(asset.format) || !SHA256.test(asset.sha256 ?? '')) {
    throw new Error(`assets[${index}] format or hash is invalid.`);
  }
  integer(asset.size, `assets[${index}].size`, 1);
  if (
    asset.updaterMetadataSha256 !== undefined
    && !SHA256.test(asset.updaterMetadataSha256)
  ) {
    throw new Error(`assets[${index}] updater metadata hash is invalid.`);
  }
  return structuredClone(asset);
}

export function validateReleaseManifest(value) {
  if (!object(value) || value.schemaVersion !== 1) {
    throw new Error('Release manifest schemaVersion must be 1.');
  }
  if (value.product !== 'github-model-relay' || !VERSION.test(value.version ?? '')) {
    throw new Error('Release manifest product or version is invalid.');
  }
  if (!CHANNELS.has(value.channel) || Number.isNaN(Date.parse(value.publishedAt ?? ''))) {
    throw new Error('Release manifest channel or timestamp is invalid.');
  }
  if (!object(value.minimumSchemas)) {
    throw new Error('minimumSchemas is required.');
  }
  for (const name of ['application', 'data', 'gateway', 'clientOwnership']) {
    integer(value.minimumSchemas[name], `minimumSchemas.${name}`, 1);
  }
  if (!Array.isArray(value.assets) || value.assets.length === 0) {
    throw new Error('Release manifest requires assets.');
  }
  const assets = value.assets.map(validateAsset);
  const targets = new Set();
  for (const asset of assets) {
    const target = `${asset.platform}/${asset.arch}/${asset.format}`;
    if (targets.has(target)) {
      throw new Error(`Duplicate release target: ${target}`);
    }
    targets.add(target);
  }
  if (!object(value.signing) || !ASSET.test(value.signing.policy ?? '')) {
    throw new Error('Release signing policy is invalid.');
  }
  if (
    value.stagingPercentage !== undefined
    && (
      typeof value.stagingPercentage !== 'number'
      || value.stagingPercentage < 0
      || value.stagingPercentage > 100
    )
  ) {
    throw new Error('stagingPercentage must be from 0 through 100.');
  }
  return { ...structuredClone(value), assets };
}

export function verifyReleaseManifest({
  manifest,
  signature,
  publicKey,
  expectedChannel,
  currentSchemas,
}) {
  const parsed = typeof manifest === 'string' ? JSON.parse(manifest) : manifest;
  const validated = validateReleaseManifest(parsed);
  if (validated.channel !== expectedChannel) {
    throw new Error(`Unexpected release channel: ${validated.channel}`);
  }
  const signatureBytes = Buffer.isBuffer(signature)
    ? signature
    : Buffer.from(signature, 'base64');
  if (!verify(
    null,
    Buffer.from(canonicalJson(validated), 'utf8'),
    publicKey,
    signatureBytes,
  )) {
    throw new Error('Release manifest signature is invalid.');
  }
  for (const [name, minimum] of Object.entries(validated.minimumSchemas)) {
    if (!Number.isSafeInteger(currentSchemas?.[name]) || currentSchemas[name] < minimum) {
      throw new Error(`Release requires unsupported ${name} schema ${minimum}.`);
    }
  }
  return validated;
}

export function selectReleaseAsset(manifest, target) {
  const asset = validateReleaseManifest(manifest).assets.find((candidate) =>
    candidate.platform === target.platform
    && candidate.arch === target.arch
    && candidate.format === target.format);
  if (!asset) {
    throw new Error(
      `Release has no ${target.platform}/${target.arch}/${target.format} asset.`,
    );
  }
  return asset;
}

export function verifyReleaseAsset(asset, content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (bytes.length !== asset.size) {
    throw new Error(`Release asset "${asset.name}" size is invalid.`);
  }
  if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
    throw new Error(`Release asset "${asset.name}" hash is invalid.`);
  }
  return true;
}
