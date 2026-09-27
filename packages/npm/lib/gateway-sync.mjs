import { compareVersions, packageVersion, payloadBackendVersion, runGateway, runGatewayJson } from "./environment.mjs";
import { readLauncherState as readState, writeLauncherState as writeState } from "./launcher-state.mjs";

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

/**
 * Brings the installed gateway up to the version shipped inside this launcher.
 *
 * The launcher updates itself from npm, but the gateway is a separate immutable
 * release on disk. Without this, a user who auto-updated the launcher would
 * keep running the old gateway until they happened to run `githubrelay update`,
 * which means a shipped fix would not reach the people it was written for.
 */
export function ensureGatewayCurrent({ announce = console.error, relink = true } = {}) {
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

  const backendVersion = payloadBackendVersion();
  if (!backendVersion) {
    return { changed: false, reason: "payload does not pin a backend version" };
  }

  announce(`Updating the gateway from ${parseGatewayVersion(active)} to ${target}...`);
  // -Version is the pinned backend version, which the installer validates
  // against the source bundle; passing the gateway version is rejected.
  const result = runGateway("update", ["-Version", backendVersion]);
  if (result.error || result.status !== 0) {
    writeState({ ...state, failedGatewayUpdate: target });
    announce("Gateway update failed; continuing on the installed release. Run 'githubrelay doctor' for details.");
    return { changed: false, reason: "update failed" };
  }

  const { failedGatewayUpdate, ...rest } = state;
  writeState({ ...rest, gatewaySyncedFor: target });

  // A release can also change what agents are configured with, such as a new
  // default model or reasoning level. Re-linking the way `githubrelay clients`
  // does applies that, keeping the user's saved and in-agent choices. It is
  // best effort: the update itself already succeeded.
  if (relink) {
    const relinked = runGateway("configure-clients", ["-Clients", "all", "-SetDefault"], { capture: true });
    if (relinked.error || relinked.status !== 0) {
      announce("Could not re-link coding agents to the new release; run 'githubrelay clients' to see why.");
    }
  }
  return { changed: true, from: parseGatewayVersion(active), to: target };
}
