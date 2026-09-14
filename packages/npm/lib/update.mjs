import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { get } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MANIFEST_URL,
  PACKAGE_NAME,
  PRODUCT_NAME,
  compareVersions,
  isWindows,
  packageVersion,
} from "./environment.mjs";

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
// Corporate proxies in front of GitHub return intermittent 504s, so a single
// transient failure must not abandon an otherwise valid update.
const RETRY_ATTEMPTS = 4;
const RETRY_DELAY_MS = 1_500;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withRetries(operation, { attempts = RETRY_ATTEMPTS, onRetry } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      onRetry?.(attempt, error);
      await delay(RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError;
}

function truthy(value) {
  if (!value) return false;
  const normalized = String(value).toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function updatesDisabled() {
  return (
    truthy(process.env.GITHUBRELAY_OFFLINE) ||
    truthy(process.env.GITHUBRELAY_DISABLE_AUTO_UPDATE) ||
    truthy(process.env.GITHUBRELAY_SKIP_UPDATE_ONCE)
  );
}

function fetchText(url, redirectsRemaining = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const request = get(url, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirectsRemaining <= 0) {
          reject(new Error(`too many redirects for ${url}`));
          return;
        }
        // Disarm this hop's timer before following the redirect; otherwise it
        // fires later and rejects a chain that has already succeeded.
        request.setTimeout(0);
        fetchText(new URL(response.headers.location, url).toString(), redirectsRemaining - 1).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`HTTP ${status} for ${url}`));
        return;
      }
      response.setEncoding("utf8");
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve(chunks.join("")));
    });
    request.setTimeout(TIMEOUT_MS, () => request.destroy(new Error(`timed out fetching ${url}`)));
    request.on("error", reject);
  });
}

export async function fetchManifest() {
  return JSON.parse(await fetchText(MANIFEST_URL));
}

/**
 * Resolves what to hand `npm install -g`. A manifest may point at a tarball on
 * GitHub Releases, which lets the launcher ship and self-update before the
 * package exists on the npm registry.
 */
function installSpec(manifest, version) {
  const tarball = manifest?.dist?.tarball;
  if (typeof tarball === "string" && /^https:\/\//.test(tarball)) {
    return tarball;
  }
  return `${PACKAGE_NAME}@${version}`;
}

function npmInstallGlobal(spec) {
  const result = isWindows()
    ? spawnSync("cmd.exe", ["/d", "/s", "/c", "npm", "install", "-g", "--force", spec], { stdio: "inherit" })
    : spawnSync("npm", ["install", "-g", "--force", spec], { stdio: "inherit" });
  return !result.error && result.status === 0;
}

function downloadTo(url, destination) {
  return new Promise((resolve, reject) => {
    const step = (target, redirectsRemaining) => {
      const request = get(target, (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          if (redirectsRemaining <= 0) return reject(new Error(`too many redirects for ${url}`));
          // Disarm this hop's timer before following the redirect.
          request.setTimeout(0);
          return step(new URL(response.headers.location, target).toString(), redirectsRemaining - 1);
        }
        if (status !== 200) {
          response.resume();
          return reject(new Error(`HTTP ${status} for ${target}`));
        }
        const file = createWriteStream(destination);
        response.pipe(file);
        file.on("finish", () => file.close(() => resolve()));
        file.on("error", reject);
      });
      request.setTimeout(DOWNLOAD_TIMEOUT_MS, () => request.destroy(new Error(`timed out fetching ${target}`)));
      request.on("error", reject);
    };
    step(url, MAX_REDIRECTS);
  });
}

/**
 * Installs from a GitHub Release tarball for networks that cannot reach the
 * npm registry. npm refuses remote tarball specs (allow-remote defaults to
 * none), but installing from a downloaded file is still permitted.
 */
async function reinstallFromTarball(fallback, version) {
  const url = fallback?.tarball;
  if (typeof url !== "string" || !/^https:\/\//.test(url)) return false;

  const workspace = mkdtempSync(join(tmpdir(), "githubrelay-update-"));
  try {
    const archive = join(workspace, `${PACKAGE_NAME}-${version}.tgz`);
    console.error("Registry unavailable; falling back to the GitHub release.");

    const notify = (attempt, error) =>
      console.error(`  attempt ${attempt} failed (${error instanceof Error ? error.message : error}); retrying...`);

    await withRetries(() => downloadTo(url, archive), { onRetry: notify });

    if (typeof fallback.sha256Url === "string" && /^https:\/\//.test(fallback.sha256Url)) {
      const published = await withRetries(() => fetchText(fallback.sha256Url), { onRetry: notify });
      const expected = /[A-Fa-f0-9]{64}/.exec(published)?.[0];
      const actual = createHash("sha256").update(readFileSync(archive)).digest("hex");
      if (expected && expected.toLowerCase() !== actual) {
        throw new Error(`checksum mismatch for ${url}`);
      }
    }

    return npmInstallGlobal(archive);
  } catch (error) {
    console.error(`Fallback update failed: ${error instanceof Error ? error.message : error}`);
    return false;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

async function reinstall(manifest, version) {
  console.error(`Updating ${PRODUCT_NAME} to ${version}...`);
  if (npmInstallGlobal(installSpec(manifest, version))) return true;
  return reinstallFromTarball(manifest?.fallback, version);
}

export { installSpec, withRetries };

/**
 * Returns true when the process was replaced by a newer launcher and the caller
 * should stop. The re-exec carries a skip flag so an update can never loop.
 */
export async function checkForUpdate({ quiet = true } = {}) {
  if (updatesDisabled()) return false;

  let manifest;
  try {
    manifest = await fetchManifest();
  } catch (error) {
    if (!quiet) {
      console.error(`Warning: could not check for updates: ${error instanceof Error ? error.message : error}`);
    }
    return false;
  }

  if (manifest?.channel && manifest.channel !== "prod") return false;
  if (typeof manifest?.version !== "string" || manifest.version.length === 0) return false;
  if (compareVersions(manifest.version, packageVersion()) <= 0) return false;

  const strategy = manifest?.bootstrap?.strategy;
  if (strategy !== "package-reinstall") return false;

  if (!(await reinstall(manifest, manifest.version))) {
    console.error("Warning: update failed. Continuing with the installed version.");
    return false;
  }

  const relaunch = spawnSync(process.execPath, [process.argv[1], ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, GITHUBRELAY_SKIP_UPDATE_ONCE: "1" },
  });
  process.exit(relaunch.status ?? 0);
}
