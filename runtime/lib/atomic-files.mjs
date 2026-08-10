import { createHash, randomBytes } from 'node:crypto';
import {
  constants as fsConstants,
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';

export class AtomicWriteConflictError extends Error {
  constructor(filePath) {
    super(`Refusing to replace "${filePath}" because it changed while the update was being prepared.`);
    this.name = 'AtomicWriteConflictError';
    this.code = 'ATOMIC_WRITE_CONFLICT';
    this.filePath = filePath;
  }
}

export class FileFormatError extends Error {
  constructor(filePath, description, options = undefined) {
    super(`Invalid ${description} in "${filePath}".`, options);
    this.name = 'FileFormatError';
    this.code = 'INVALID_FILE_FORMAT';
    this.filePath = filePath;
  }
}

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function fileExists(filePath) {
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

export async function readTextFile(filePath, { required = false, label = 'file' } = {}) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' && !required) {
      return null;
    }
    if (error?.code === 'ENOENT') {
      throw new Error(`Required ${label} "${filePath}" does not exist.`, { cause: error });
    }
    throw new Error(`Unable to read ${label} "${filePath}".`, { cause: error });
  }
}

export async function readJsonFile(filePath, { required = false, label = 'JSON file' } = {}) {
  const text = await readTextFile(filePath, { required, label });
  if (text === null) {
    return null;
  }

  try {
    return JSON.parse(text.startsWith('\uFEFF') ? text.slice(1) : text);
  } catch (error) {
    throw new FileFormatError(filePath, label, { cause: error });
  }
}

function asBuffer(value, encoding) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value, encoding);
}

function equalBuffers(left, right) {
  if (left === null || right === null) {
    return left === right;
  }
  return left.length === right.length && left.equals(right);
}

async function readBufferIfPresent(filePath) {
  try {
    return await readFile(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function backupTimestamp(now) {
  const date = typeof now === 'function' ? now() : now;
  const parsed = date instanceof Date ? date : new Date(date ?? Date.now());
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError('The backup timestamp seam returned an invalid date.');
  }
  return parsed.toISOString().replaceAll('-', '').replaceAll(':', '');
}

async function reserveBackupPath(filePath, timestamp) {
  for (let counter = 0; counter < 10_000; counter += 1) {
    const discriminator = counter === 0 ? '' : `-${counter}`;
    const candidate = `${filePath}.backup-${timestamp}${discriminator}`;
    try {
      await copyFile(filePath, candidate, fsConstants.COPYFILE_EXCL);
      return candidate;
    } catch (error) {
      if (error?.code === 'EEXIST') {
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Unable to allocate a unique adjacent backup for "${filePath}".`);
}

export async function createTimestampedBackup(
  filePath,
  { expectedContent = undefined, now = () => new Date() } = {},
) {
  const expected = expectedContent === undefined
    ? await readBufferIfPresent(filePath)
    : asBuffer(expectedContent, 'utf8');

  if (expected === null) {
    return null;
  }

  const current = await readBufferIfPresent(filePath);
  if (!equalBuffers(current, expected)) {
    throw new AtomicWriteConflictError(filePath);
  }

  const backupPath = await reserveBackupPath(filePath, backupTimestamp(now));
  const [backupContent, afterCopy] = await Promise.all([
    readFile(backupPath),
    readBufferIfPresent(filePath),
  ]);

  if (!equalBuffers(backupContent, expected) || !equalBuffers(afterCopy, expected)) {
    try {
      await unlink(backupPath);
    } catch {
      // A failed cleanup is less dangerous than treating a torn copy as a valid backup.
    }
    throw new AtomicWriteConflictError(filePath);
  }

  return backupPath;
}

async function syncDirectory(directoryPath) {
  let handle;
  try {
    handle = await open(directoryPath, 'r');
    await handle.sync();
  } catch (error) {
    // Windows and some network filesystems do not allow directory handles to be synced.
    if (!['EACCES', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'].includes(error?.code)) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

async function replacePreparedFile(tempPath, targetPath, expectedCurrent) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rename(tempPath, targetPath);
      return;
    } catch (error) {
      lastError = error;
      if (
        expectedCurrent === null
        || !['EACCES', 'EEXIST', 'EPERM'].includes(error?.code)
      ) {
        throw error;
      }
      const current = await readBufferIfPresent(targetPath);
      if (!equalBuffers(current, expectedCurrent)) {
        throw new AtomicWriteConflictError(targetPath);
      }
      await new Promise((resolve) => setTimeout(resolve, 25 * (2 ** attempt)));
    }
  }
  throw lastError;
}

export async function atomicWriteFile(
  filePath,
  value,
  {
    backup = false,
    dryRun = false,
    encoding = 'utf8',
    expectedContent = undefined,
    mode = 0o600,
    now = () => new Date(),
  } = {},
) {
  const next = asBuffer(value, encoding);
  const observed = await readBufferIfPresent(filePath);
  const expected = expectedContent === undefined
    ? observed
    : expectedContent === null
      ? null
      : asBuffer(expectedContent, encoding);

  if (!equalBuffers(observed, expected)) {
    throw new AtomicWriteConflictError(filePath);
  }

  if (equalBuffers(observed, next)) {
    const confirmed = await readBufferIfPresent(filePath);
    if (!equalBuffers(confirmed, expected)) {
      throw new AtomicWriteConflictError(filePath);
    }
    return {
      changed: false,
      created: false,
      backupPath: null,
      bytes: next.length,
    };
  }

  if (dryRun) {
    return {
      changed: true,
      created: observed === null,
      backupPath: null,
      bytes: next.length,
    };
  }

  const directoryPath = path.dirname(filePath);
  await mkdir(directoryPath, { recursive: true });

  let backupPath = null;
  if (backup && observed !== null) {
    backupPath = await createTimestampedBackup(filePath, {
      expectedContent: observed,
      now,
    });
  }

  let targetMode = mode;
  if (observed !== null) {
    try {
      targetMode = (await stat(filePath)).mode;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
      throw new AtomicWriteConflictError(filePath);
    }
  }

  const tempPath = path.join(
    directoryPath,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`,
  );

  let tempHandle;
  let preparationError = null;
  try {
    tempHandle = await open(tempPath, 'wx', targetMode);
    await tempHandle.writeFile(next);
    await tempHandle.sync();
  } catch (error) {
    preparationError = error;
  } finally {
    await tempHandle?.close();
  }
  if (preparationError !== null) {
    try {
      await unlink(tempPath);
    } catch {
      // The file may not have been created, or cleanup may be temporarily blocked.
    }
    throw preparationError;
  }

  try {
    const beforeReplace = await readBufferIfPresent(filePath);
    if (!equalBuffers(beforeReplace, expected)) {
      throw new AtomicWriteConflictError(filePath);
    }
    await replacePreparedFile(tempPath, filePath, expected);
    await syncDirectory(directoryPath);
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch {
      // Ignore cleanup failure; the uniquely named temp file is never executed.
    }
    throw error;
  }

  return {
    changed: true,
    created: observed === null,
    backupPath,
    bytes: next.length,
  };
}

export async function atomicWriteJson(filePath, value, options = {}) {
  return atomicWriteFile(filePath, serializeJson(value), options);
}

export async function atomicRemoveFile(
  filePath,
  {
    backup = false,
    dryRun = false,
    expectedContent = undefined,
    now = () => new Date(),
  } = {},
) {
  const observed = await readBufferIfPresent(filePath);
  if (observed === null) {
    return { changed: false, backupPath: null };
  }

  const expected = expectedContent === undefined
    ? observed
    : asBuffer(expectedContent, 'utf8');
  if (!equalBuffers(observed, expected)) {
    throw new AtomicWriteConflictError(filePath);
  }

  if (dryRun) {
    return { changed: true, backupPath: null };
  }

  const backupPath = backup
    ? await createTimestampedBackup(filePath, { expectedContent: observed, now })
    : null;

  const beforeRemove = await readBufferIfPresent(filePath);
  if (!equalBuffers(beforeRemove, expected)) {
    throw new AtomicWriteConflictError(filePath);
  }
  await unlink(filePath);
  await syncDirectory(path.dirname(filePath));
  return { changed: true, backupPath };
}
