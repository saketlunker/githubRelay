import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The launcher's own small state, kept apart from the gateway's. */
export function launcherStateDir() {
  const root = process.env.LOCALAPPDATA ?? process.env.HOME ?? ".";
  return join(root, "githubrelay");
}

function statePath() {
  return join(launcherStateDir(), "launcher-state.json");
}

export function readLauncherState() {
  try {
    return JSON.parse(readFileSync(statePath(), "utf8"));
  } catch {
    return {};
  }
}

export function writeLauncherState(state) {
  try {
    mkdirSync(launcherStateDir(), { recursive: true });
    writeFileSync(statePath(), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch {
    // State is an optimisation; failing to record it must not break a command.
  }
}

/** Re-reads first, so another launcher's keys are kept. An undefined value removes a key. */
export function updateLauncherState(patch) {
  writeLauncherState({ ...readLauncherState(), ...patch });
}
