import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = dirname(dirname(packageRoot));

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("release manifest matches what the launcher expects", () => {
  const manifest = readJson(join(repositoryRoot, "releases", "prod", "latest.json"));

  assert.equal(manifest.product, "githubrelay");
  assert.equal(manifest.channel, "prod");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(
    manifest.bootstrap.strategy,
    "package-reinstall",
    "the launcher only self-updates on the package-reinstall strategy",
  );
});

test("manifest version tracks the published package version", () => {
  const manifest = readJson(join(repositoryRoot, "releases", "prod", "latest.json"));
  const npmPackage = readJson(join(packageRoot, "package.json"));

  assert.equal(
    manifest.version,
    npmPackage.version,
    "a manifest ahead of the package triggers an update loop for every user",
  );
});

test("npm package ships the payload and nothing unexpected", () => {
  const npmPackage = readJson(join(packageRoot, "package.json"));

  assert.equal(npmPackage.name, "githubrelay");
  assert.ok(npmPackage.files.includes("payload/"), "payload carries the gateway sources");
  assert.ok(npmPackage.files.includes("bin/"));
  assert.equal(npmPackage.bin.githubrelay, "bin/githubrelay.js");
  assert.equal(
    npmPackage.dependencies,
    undefined,
    "the launcher must stay dependency-free so install cannot break on the supply chain",
  );
});

test("install carries no lifecycle scripts", () => {
  const npmPackage = readJson(join(packageRoot, "package.json"));

  // npm 12 blocks dependency lifecycle scripts by default, so relying on one
  // would silently do nothing and emit a blocked-script warning on install.
  for (const hook of ["preinstall", "install", "postinstall"]) {
    assert.equal(npmPackage.scripts[hook], undefined, `${hook} must not be used`);
  }
});

test("repository pins the backend to an exact version", () => {
  const rootPackage = readJson(join(repositoryRoot, "package.json"));
  assert.match(rootPackage.dependencies["@jeffreycao/copilot-api"], /^\d+\.\d+\.\d+$/);
});
