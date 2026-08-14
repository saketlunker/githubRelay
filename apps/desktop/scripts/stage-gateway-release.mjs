import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import AdmZip from 'adm-zip';

const directory = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(directory, '..');
const repositoryRoot = path.resolve(desktopRoot, '..', '..');
const staging = path.join(desktopRoot, '.gateway-release');
const archive = path.join(desktopRoot, '.gateway-release.zip');

function run(file, arguments_, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, arguments_, {
      ...options,
      shell: false,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${file} exited with ${code}.`));
      }
    });
  });
}

await rm(staging, { recursive: true, force: true });
await rm(archive, { force: true });
await mkdir(path.join(staging, 'apps', 'desktop'), { recursive: true });
await Promise.all([
  cp(path.join(repositoryRoot, 'package.json'), path.join(staging, 'package.json')),
  cp(
    path.join(repositoryRoot, 'package-lock.json'),
    path.join(staging, 'package-lock.json'),
  ),
  cp(
    path.join(desktopRoot, 'package.json'),
    path.join(staging, 'apps', 'desktop', 'package.json'),
  ),
  cp(path.join(repositoryRoot, 'runtime'), path.join(staging, 'runtime'), {
    recursive: true,
  }),
  cp(path.join(repositoryRoot, 'licenses'), path.join(staging, 'licenses'), {
    recursive: true,
  }),
  cp(
    path.join(repositoryRoot, 'THIRD_PARTY_NOTICES.md'),
    path.join(staging, 'THIRD_PARTY_NOTICES.md'),
  ),
]);

const npmExecutable = process.env.npm_execpath;
if (!npmExecutable) {
  throw new Error('npm_execpath is unavailable.');
}
await run(
  process.execPath,
  [
    npmExecutable,
    'ci',
    '--omit=dev',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--workspaces',
    '--include-workspace-root',
  ],
  { cwd: staging },
);

const backendPackage = JSON.parse(await readFile(
  path.join(staging, 'node_modules', '@jeffreycao', 'copilot-api', 'package.json'),
  'utf8',
));
if (backendPackage.version !== '2.0.1') {
  throw new Error(`Unexpected staged backend version: ${backendPackage.version}`);
}

const zip = new AdmZip();
zip.addLocalFolder(staging);
zip.writeZip(archive);
