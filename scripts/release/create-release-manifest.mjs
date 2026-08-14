import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { canonicalJson } from "../../runtime/lib/release-manifest.mjs";

const [directory, version, channel = "stable"] = process.argv.slice(2);
if (!directory || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
  throw new Error("Usage: create-release-manifest.mjs <directory> <version> [stable|beta]");
}
if (!["stable", "beta"].includes(channel)) {
  throw new Error("Channel must be stable or beta.");
}

const extensionFormat = new Map([
  [".exe", { platform: "win32", format: "nsis" }],
  [".dmg", { platform: "darwin", format: "dmg" }],
  [".zip", { platform: "darwin", format: "zip" }],
  [".AppImage", { platform: "linux", format: "appimage" }],
  [".deb", { platform: "linux", format: "deb" }],
]);
const assets = [];
for (const name of await readdir(directory)) {
  const matched = [...extensionFormat.entries()].find(([extension]) =>
    name.endsWith(extension));
  if (!matched) {
    continue;
  }
  const file = path.join(directory, name);
  const bytes = await readFile(file);
  const target = matched[1];
  const architecture = /arm64/i.test(name) ? "arm64" : "x64";
  assets.push({
    name,
    platform: target.platform,
    arch: architecture,
    format: target.format,
    size: (await stat(file)).size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
if (assets.length === 0) {
  throw new Error("No package assets were found.");
}
const manifest = {
  schemaVersion: 1,
  product: "github-model-relay",
  version,
  channel,
  publishedAt: new Date().toISOString(),
  minimumSchemas: {
    application: 1,
    data: 1,
    gateway: 1,
    clientOwnership: 1,
  },
  assets: assets.sort((left, right) => left.name.localeCompare(right.name)),
  signing: {
    policy: process.env.MODEL_RELAY_MANIFEST_KEY_ID
      ?? "corporate-signing-not-configured",
  },
};
await writeFile(
  path.join(directory, "release-manifest.json"),
  canonicalJson(manifest),
  "utf8",
);
