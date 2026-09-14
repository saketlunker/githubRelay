import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { compareVersions, packageVersion, runGateway, runGatewayJson } from "./environment.mjs";

const RELEASE_ID = /^gateway-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-backend-/;

export function parseGatewayVersion(activeRelease) {
  return RELEASE_ID.exec(String(activeRelease ?? ""))?.[1];
}

/**
 * An unrecognisable release id means an install this launcher does not
 * understand, so it is left alone rather than guessed at.
 */
export function gatewayNeedsUpdate(activeRelease, payloadVersion) {
  const installed = parseGatewayVersion(activeRelease);
  if (!installed) return false;
  return compareVersions(payloadVersion, installed) > 0;
}

function statePath() {
  const root = process.env.LOCALAPPDATA ?? process.env.HOME ?? ".";
  return join(root, "githubrelay", "launcher-state.json");
}

function readState() {
  try {
    return JSON.parse(readFileSync(statePath(), "utf8"));
  } catch {
    return {};
  }
}

function writeState(state) {
  try {
    const path = statePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch {
    // State is an optimisation; failing to record it must not break a command.
  }
}

/**
 * Brings the installed gateway up to the version shipped inside this launcher.
 *
 * The launcher updates itself from npm, but the gateway is a separate immutable
 * release on disk. Without this, a user who auto-updated the launcher would
 * keep running the old gateway until they happened to run `githubrelay update`,
 * which means a shipped fix would not reach the people it was written for.
 */
export function ensureGatewayCurrent({ announce = console.error } = {}) {
  const target = packageVersion();
  const state = readState();

  // Checking costs a PowerShell spawn, so it runs once per launcher version
  // rather than on every command.
  if (state.gatewaySyncedFor === target) return { changed: false, reason: "already checked" };
  if (state.failedGatewayUpdate === target) {
    return { changed: false, reason: "previous attempt for this version failed" };
  }

  const status = runGatewayJson("status");
  if (!status.ok) return { changed: false, reason: "gateway not installed" };

  const active = status.value?.ActiveRelease;
  if (!gatewayNeedsUpdate(active, target)) {
    writeState({ ...state, gatewaySyncedFor: target });
    return { changed: false, reason: "current" };
  }

  announce(`Updating the gateway from ${parseGatewayVersion(active)} to ${target}...`);
  const result = runGateway("update");
  if (result.error || result.status !== 0) {
    writeState({ ...state, failedGatewayUpdate: target });
    announce("Gateway update failed; continuing on the installed release. Run 'githubrelay doctor' for details.");
    return { changed: false, reason: "update failed" };
  }

  const { failedGatewayUpdate, ...rest } = state;
  writeState({ ...rest, gatewaySyncedFor: target });
  return { changed: true, from: parseGatewayVersion(active), to: target };
}
