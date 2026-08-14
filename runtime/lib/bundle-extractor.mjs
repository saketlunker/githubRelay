import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import AdmZip from 'adm-zip';

const MAX_FILES = 100_000;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;

function safeEntryName(name) {
  if (
    typeof name !== 'string'
    || name.length === 0
    || name.includes('\\')
    || name.startsWith('/')
    || /^[A-Za-z]:/.test(name)
  ) {
    return false;
  }
  const normalized = path.posix.normalize(name);
  return normalized !== '..'
    && !normalized.startsWith('../')
    && !path.posix.isAbsolute(normalized);
}

async function validExistingRelease(target) {
  try {
    const entrypoint = path.join(
      target,
      'node_modules',
      '@jeffreycao',
      'copilot-api',
      'dist',
      'main.js',
    );
    return (await stat(entrypoint)).isFile();
  } catch {
    return false;
  }
}

export async function extractGatewayBundle({
  archive,
  target,
  expectedBackendVersion,
}) {
  if (await validExistingRelease(target)) {
    return path.resolve(target);
  }
  const zip = new AdmZip(path.resolve(archive));
  const entries = zip.getEntries();
  if (entries.length === 0 || entries.length > MAX_FILES) {
    throw new Error('Gateway bundle has an invalid file count.');
  }
  let total = 0;
  for (const entry of entries) {
    if (!safeEntryName(entry.entryName)) {
      throw new Error(`Gateway bundle contains an unsafe path: ${entry.entryName}`);
    }
    total += entry.header.size;
    if (total > MAX_BYTES) {
      throw new Error('Gateway bundle exceeds its extracted size limit.');
    }
  }
  await mkdir(path.dirname(path.resolve(target)), {
    recursive: true,
    mode: 0o700,
  });
  const staging = `${path.resolve(target)}.extract-${process.pid}-${Date.now()}`;
  await mkdir(staging, { recursive: false, mode: 0o700 });
  try {
    for (const entry of entries) {
      const destination = path.join(staging, ...entry.entryName.split('/'));
      if (!destination.startsWith(`${staging}${path.sep}`) && destination !== staging) {
        throw new Error(`Gateway bundle escaped staging: ${entry.entryName}`);
      }
      if (entry.isDirectory) {
        await mkdir(destination, { recursive: true, mode: 0o700 });
        continue;
      }
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, entry.getData(), { mode: 0o600, flag: 'wx' });
      if (process.platform !== 'win32') {
        await chmod(destination, 0o600);
      }
    }
    const packageJson = JSON.parse(await readFile(
      path.join(
        staging,
        'node_modules',
        '@jeffreycao',
        'copilot-api',
        'package.json',
      ),
      'utf8',
    ));
    if (packageJson.version !== expectedBackendVersion) {
      throw new Error(
        `Gateway bundle backend ${packageJson.version} is not ${expectedBackendVersion}.`,
      );
    }
    await rename(staging, path.resolve(target));
    return path.resolve(target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
