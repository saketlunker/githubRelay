import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(directory, "..");

test("renderer enforces a local-only content security policy", async () => {
  const html = await readFile(
    path.join(desktop, "dist", "renderer", "index.html"),
    "utf8",
  );
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'self'/);
  assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(html, /https?:\/\/[^"]+\.js/);
});

test("Electron main uses an isolated sandboxed renderer", async () => {
  const source = await readFile(
    path.join(desktop, "src", "main", "index.ts"),
    "utf8",
  );
  assert.match(source, /contextIsolation:\s*true/);
  assert.match(source, /nodeIntegration:\s*false/);
  assert.match(source, /sandbox:\s*true/);
  assert.match(source, /setWindowOpenHandler/);
  assert.match(source, /will-navigate/);
});

test("preload exposes no generic IPC primitive", async () => {
  const source = await readFile(
    path.join(desktop, "src", "preload", "index.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /ipcRenderer\.(?:send|sendSync)\(/);
  assert.match(source, /contextBridge\.exposeInMainWorld/);
  assert.match(source, /Object\.freeze/);
});

test("staged package contains the bundled gateway runtime", async () => {
  const unpacked = path.join(desktop, ".gateway-release");
  const files = [
    path.join(unpacked, "runtime", "supervisor.mjs"),
    path.join(
      unpacked,
      "node_modules",
      "@jeffreycao",
      "copilot-api",
      "dist",
      "main.js",
    ),
  ];
  for (const file of files) {
    assert.equal((await stat(file)).isFile(), true, file);
  }
  assert.equal(
    (await stat(path.join(desktop, ".gateway-release.zip"))).isFile(),
    true,
  );
});
