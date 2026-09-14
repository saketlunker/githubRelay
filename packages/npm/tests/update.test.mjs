import assert from "node:assert/strict";
import { test } from "node:test";

import { installSpec } from "../lib/update.mjs";

test("a manifest tarball is preferred so updates work without the npm registry", () => {
  const spec = installSpec(
    { dist: { tarball: "https://github.com/saketlunker/githubRelay/releases/download/npm-v0.3.0/githubrelay-0.3.0.tgz" } },
    "0.3.0",
  );

  assert.equal(spec, "https://github.com/saketlunker/githubRelay/releases/download/npm-v0.3.0/githubrelay-0.3.0.tgz");
});

test("the published manifest updates through the npm registry", async () => {
  const { readFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const repositoryRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, "releases", "prod", "latest.json"), "utf8"));

  // npm 12 refuses remote tarball specs (allow-remote=none), so shipping a
  // dist.tarball in the manifest would break self-update for every user.
  assert.equal(manifest.dist, undefined, "manifest must not carry a tarball once the package is on npm");
  assert.equal(installSpec(manifest, manifest.version), `githubrelay@${manifest.version}`);
});

test("the manifest publishes a release fallback for registry-blocked networks", async () => {
  const { readFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const repositoryRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, "releases", "prod", "latest.json"), "utf8"));

  assert.match(manifest.fallback.tarball, /^https:\/\/github\.com\/.+\.tgz$/);
  assert.match(manifest.fallback.sha256Url, /^https:\/\/github\.com\/.+\.sha256$/);
  assert.ok(
    manifest.fallback.tarball.includes(manifest.version),
    "the fallback tarball must match the manifest version",
  );

  // The fallback must stay out of dist, or installSpec would hand npm a remote
  // URL and every update would be rejected before the fallback is reached.
  assert.equal(installSpec(manifest, manifest.version), `githubrelay@${manifest.version}`);
});

test("falls back to the registry name when no tarball is published", () => {
  assert.equal(installSpec({}, "0.3.0"), "githubrelay@0.3.0");
  assert.equal(installSpec(undefined, "0.3.0"), "githubrelay@0.3.0");
});

test("a non-https tarball is refused so updates cannot be downgraded to plain http", () => {
  assert.equal(installSpec({ dist: { tarball: "http://example.com/evil.tgz" } }, "0.3.0"), "githubrelay@0.3.0");
  assert.equal(installSpec({ dist: { tarball: "file:///tmp/evil.tgz" } }, "0.3.0"), "githubrelay@0.3.0");
  assert.equal(installSpec({ dist: { tarball: 42 } }, "0.3.0"), "githubrelay@0.3.0");
});
