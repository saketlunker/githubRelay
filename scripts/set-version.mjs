#!/usr/bin/env node
/**
 * Sets the product version everywhere it is recorded.
 *
 * Only the product's own fields are edited, as JSON. Replacing the version
 * string textually also rewrote every dependency that happened to share it:
 * across several releases that silently changed `tmp` and `unicorn-magic` in
 * package-lock.json until `npm ci` rejected the lock, which would have broken
 * the gateway install that runs `npm ci` on every user's machine.
 *
 * Usage: node scripts/set-version.mjs 1.2.3
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPOSITORY = "saketlunker/githubRelay";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("usage: node scripts/set-version.mjs <major.minor.patch>");
  process.exit(2);
}

function editJson(relative, mutate) {
  const file = path.join(repositoryRoot, relative);
  const text = readFileSync(file, "utf8");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const value = JSON.parse(text);
  mutate(value);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`.replace(/\n/g, eol), "utf8");
}

editJson("package.json", (manifest) => {
  manifest.version = version;
});
editJson(path.join("apps", "desktop", "package.json"), (manifest) => {
  manifest.version = version;
});
editJson(path.join("packages", "npm", "package.json"), (manifest) => {
  manifest.version = version;
});
editJson("package-lock.json", (lock) => {
  lock.version = version;
  lock.packages[""].version = version;
  lock.packages["apps/desktop"].version = version;
});
editJson(path.join("releases", "prod", "latest.json"), (manifest) => {
  const tag = `npm-v${version}`;
  manifest.version = version;
  manifest.publishedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  manifest.notesUrl = `https://github.com/${REPOSITORY}/releases/tag/${tag}`;
  if (manifest.fallback) {
    manifest.fallback.tarball =
      `https://github.com/${REPOSITORY}/releases/download/${tag}/githubrelay-${version}.tgz`;
    manifest.fallback.sha256Url = `${manifest.fallback.tarball}.sha256`;
  }
});

console.log(`Version set to ${version}; tag the release as npm-v${version}.`);
