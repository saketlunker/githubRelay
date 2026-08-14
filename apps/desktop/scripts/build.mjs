import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const directory = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(directory, '..');
const output = path.join(desktopRoot, 'dist');
await rm(output, { recursive: true, force: true });
await Promise.all([
  mkdir(path.join(output, 'main'), { recursive: true }),
  mkdir(path.join(output, 'preload'), { recursive: true }),
  mkdir(path.join(output, 'renderer'), { recursive: true }),
]);

await Promise.all([
  build({
    entryPoints: [path.join(desktopRoot, 'src', 'main', 'index.ts')],
    outfile: path.join(output, 'main', 'index.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    mainFields: ['module', 'main'],
    define: { 'import.meta.url': 'undefined' },
    sourcemap: true,
    external: ['electron', 'electron-updater'],
    logLevel: 'info',
  }),
  build({
    entryPoints: [path.join(desktopRoot, 'src', 'preload', 'index.ts')],
    outfile: path.join(output, 'preload', 'index.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    sourcemap: true,
    external: ['electron'],
    logLevel: 'info',
  }),
  build({
    entryPoints: [path.join(desktopRoot, 'src', 'renderer', 'index.ts')],
    outfile: path.join(output, 'renderer', 'index.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: ['chrome136'],
    sourcemap: true,
    logLevel: 'info',
  }),
]);

await Promise.all([
  cp(
    path.join(desktopRoot, 'src', 'renderer', 'index.html'),
    path.join(output, 'renderer', 'index.html'),
  ),
  cp(
    path.join(desktopRoot, 'src', 'renderer', 'styles.css'),
    path.join(output, 'renderer', 'styles.css'),
  ),
]);
