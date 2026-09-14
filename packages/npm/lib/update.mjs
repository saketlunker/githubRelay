import { spawnSync } from "node:child_process";
import { get } from "node:https";

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

function reinstall(version) {
  const spec = `${PACKAGE_NAME}@${version}`;
  console.error(`Updating ${PRODUCT_NAME} to ${version}...`);
  const result = isWindows()
    ? spawnSync("cmd.exe", ["/d", "/s", "/c", "npm", "install", "-g", "--force", spec], { stdio: "inherit" })
    : spawnSync("npm", ["install", "-g", "--force", spec], { stdio: "inherit" });
  return !result.error && result.status === 0;
}

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

  if (!reinstall(manifest.version)) {
    console.error("Warning: update failed. Continuing with the installed version.");
    return false;
  }

  const relaunch = spawnSync(process.execPath, [process.argv[1], ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, GITHUBRELAY_SKIP_UPDATE_ONCE: "1" },
  });
  process.exit(relaunch.status ?? 0);
}
