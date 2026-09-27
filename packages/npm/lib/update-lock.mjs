import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

import { launcherStateDir } from "./launcher-state.mjs";

export const LOCK_HELD_ENV = "GITHUBRELAY_UPDATE_LOCK_HELD";
// Longer than any real update, so a lock is only taken over from a launcher
// that died or hung.
const STALE_AFTER_MS = 15 * 60_000;

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readHolder(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Lets only one launcher install updates at a time. The sign-in updater and a
 * command the user types could otherwise run `npm install -g` over each other
 * and leave a half-written launcher behind.
 *
 * Anything unexpected, such as an unwritable state folder, fails open: a lock
 * that cannot be taken must not stop every future update.
 */
export function acquireUpdateLock({
  dir = launcherStateDir(),
  env = process.env,
  pid = process.pid,
  now = Date.now,
  isAlive = processAlive,
} = {}) {
  const nothing = () => {};
  // A launcher re-run after its own update works under its parent's lock.
  if (env[LOCK_HELD_ENV] === "1") return { acquired: true, release: nothing };

  const path = join(dir, "update.lock");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return { acquired: true, release: nothing };
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor;
    try {
      descriptor = openSync(path, "wx");
    } catch (error) {
      if (error?.code !== "EEXIST") return { acquired: true, release: nothing };
      const holder = readHolder(path);
      const fresh = typeof holder?.pid === "number"
        && now() - holder.at < STALE_AFTER_MS
        && isAlive(holder.pid);
      if (fresh) return { acquired: false, holder, release: nothing };
      rmSync(path, { force: true });
      continue;
    }
    writeSync(descriptor, JSON.stringify({ pid, at: now() }));
    closeSync(descriptor);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (readHolder(path)?.pid === pid) rmSync(path, { force: true });
    };
    return { acquired: true, release };
  }
  return { acquired: false, release: nothing };
}
