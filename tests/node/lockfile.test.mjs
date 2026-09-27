import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..", "..");

function readJson(...segments) {
  return JSON.parse(readFileSync(path.join(repositoryRoot, ...segments), "utf8"));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("every locked package's version matches the tarball it resolves to", () => {
  // A textual version bump once rewrote dependencies that shared the product
  // version, leaving entries such as tmp "0.3.2" that resolved tmp-0.2.7.tgz,
  // until npm ci rejected the lock outright.
  const lock = readJson("package-lock.json");
  const mismatches = [];
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (!key.includes("node_modules/") || typeof entry.resolved !== "string") {
      continue;
    }
    const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
    const base = name.includes("/") ? name.split("/")[1] : name;
    const match = new RegExp(`/-/${escapeRegExp(base)}-([^/]+)\\.tgz$`).exec(entry.resolved);
    if (match && match[1] !== entry.version) {
      mismatches.push(`${key}: locked ${entry.version}, resolves ${match[1]}`);
    }
  }
  assert.deepEqual(mismatches, []);
});

test("the lockfile records the product version it was bumped to", () => {
  const lock = readJson("package-lock.json");
  const root = readJson("package.json");
  const desktop = readJson("apps", "desktop", "package.json");

  assert.equal(lock.version, root.version);
  assert.equal(lock.packages[""].version, root.version);
  assert.equal(lock.packages["apps/desktop"].version, desktop.version);
  assert.equal(desktop.version, root.version);
});
