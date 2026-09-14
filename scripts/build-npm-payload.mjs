#!/usr/bin/env node
/**
 * Stages the gateway payload into packages/npm/payload/ so the published npm
 * package can act as the -SourceRoot that Install-CHGGateway expects.
 *
 * The payload deliberately carries the repository root package.json and
 * package-lock.json: the installer reads the pinned backend version from them
 * and runs `npm ci` against that lock inside an immutable release directory.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = join(repositoryRoot, "packages", "npm");
const payloadRoot = join(packageRoot, "payload");

const REQUIRED_DIRECTORIES = ["runtime", "powershell"];
const REQUIRED_FILES = ["gateway.ps1", "package.json", "package-lock.json"];
const OPTIONAL_ENTRIES = ["THIRD_PARTY_NOTICES.md", "licenses", "SECURITY.md"];

function assertSources() {
  const missing = [...REQUIRED_DIRECTORIES, ...REQUIRED_FILES].filter(
    (entry) => !existsSync(join(repositoryRoot, entry)),
  );
  if (missing.length > 0) {
    throw new Error(`missing payload sources: ${missing.join(", ")}`);
  }
}

function assertBackendPin() {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
  const pin = manifest.dependencies?.["@jeffreycao/copilot-api"];
  if (!/^\d+\.\d+\.\d+$/.test(pin ?? "")) {
    throw new Error(`repository package.json must pin @jeffreycao/copilot-api to an exact version, found: ${pin}`);
  }
  return pin;
}

function syncVersions() {
  const rootManifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
  const packageManifestPath = join(packageRoot, "package.json");
  const packageManifest = JSON.parse(readFileSync(packageManifestPath, "utf8"));
  if (packageManifest.version !== rootManifest.version) {
    packageManifest.version = rootManifest.version;
    writeFileSync(packageManifestPath, `${JSON.stringify(packageManifest, null, 2)}\n`, "utf8");
    return `synced npm package version to ${rootManifest.version}`;
  }
  return `npm package version already ${packageManifest.version}`;
}

function build() {
  assertSources();
  const backendVersion = assertBackendPin();

  rmSync(payloadRoot, { recursive: true, force: true });
  mkdirSync(payloadRoot, { recursive: true });

  for (const entry of [...REQUIRED_DIRECTORIES, ...REQUIRED_FILES, ...OPTIONAL_ENTRIES]) {
    const source = join(repositoryRoot, entry);
    if (!existsSync(source)) continue;
    cpSync(source, join(payloadRoot, entry), { recursive: true });
  }

  const versionNote = syncVersions();

  console.log(`Payload staged at ${payloadRoot}`);
  console.log(`Pinned backend: @jeffreycao/copilot-api@${backendVersion}`);
  console.log(versionNote);
}

build();
