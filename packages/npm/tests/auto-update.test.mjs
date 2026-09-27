import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createLogWriter, formatAutoUpdate, sameTaskTarget, updateTaskArguments } from "../lib/auto-update.mjs";
import { LOCK_HELD_ENV, acquireUpdateLock } from "../lib/update-lock.mjs";
import { withRetries } from "../lib/update.mjs";

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "githubrelay-auto-update-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the sign-in task runs the launcher hidden, quoting paths with spaces and apostrophes", () => {
  const argumentsText = updateTaskArguments({
    node: "C:\\Program Files\\nodejs\\node.exe",
    script: "C:\\Users\\Pat O'Brien\\AppData\\Roaming\\npm\\node_modules\\githubrelay\\bin\\githubrelay.js",
  });

  assert.equal(
    argumentsText,
    "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command "
      + "\"& 'C:\\Program Files\\nodejs\\node.exe' "
      + "'C:\\Users\\Pat O''Brien\\AppData\\Roaming\\npm\\node_modules\\githubrelay\\bin\\githubrelay.js' auto-update\"",
  );
});

test("the task is re-registered only when its definition or paths change", () => {
  const target = { definition: 1, node: "C:\\node.exe", script: "C:\\relay.js" };
  assert.equal(sameTaskTarget({ ...target, name: "GitHubRelay-Update-x" }, target), true);
  assert.equal(sameTaskTarget(undefined, target), false);
  assert.equal(sameTaskTarget({ ...target, node: "D:\\node.exe" }, target), false);
  assert.equal(sameTaskTarget({ ...target, definition: 0 }, target), false);
});

test("only one launcher holds the update lock while it is alive", (t) => {
  const dir = scratch(t);
  const first = acquireUpdateLock({ dir, env: {}, pid: 100, isAlive: () => true });
  assert.equal(first.acquired, true);

  const second = acquireUpdateLock({ dir, env: {}, pid: 200, isAlive: () => true });
  assert.equal(second.acquired, false);
  assert.equal(second.holder.pid, 100);

  // Releasing someone else's lock must not remove it.
  second.release();
  assert.equal(acquireUpdateLock({ dir, env: {}, pid: 300, isAlive: () => true }).acquired, false);

  first.release();
  const third = acquireUpdateLock({ dir, env: {}, pid: 300, isAlive: () => true });
  assert.equal(third.acquired, true);
  third.release();
});

test("a lock left by a dead or hung launcher is taken over", (t) => {
  const dir = scratch(t);
  writeFileSync(join(dir, "update.lock"), JSON.stringify({ pid: 100, at: Date.now() }));
  assert.equal(acquireUpdateLock({ dir, env: {}, pid: 200, isAlive: () => false }).acquired, true, "dead holder");

  writeFileSync(join(dir, "update.lock"), JSON.stringify({ pid: 100, at: Date.now() - 16 * 60_000 }));
  assert.equal(acquireUpdateLock({ dir, env: {}, pid: 200, isAlive: () => true }).acquired, true, "older than any update");

  writeFileSync(join(dir, "update.lock"), "not json");
  assert.equal(acquireUpdateLock({ dir, env: {}, pid: 200, isAlive: () => true }).acquired, true, "unreadable");
});

test("a launcher re-run after its own update works under its parent's lock", (t) => {
  const dir = scratch(t);
  const parent = acquireUpdateLock({ dir, env: {}, pid: 100, isAlive: () => true });
  const child = acquireUpdateLock({ dir, env: { [LOCK_HELD_ENV]: "1" }, pid: 200, isAlive: () => true });
  assert.equal(child.acquired, true);
  child.release();
  assert.equal(acquireUpdateLock({ dir, env: {}, pid: 300, isAlive: () => true }).acquired, false, "the parent still holds it");
  parent.release();
});

test("the hidden run keeps a timestamped log and rotates it", (t) => {
  const dir = scratch(t);
  const path = join(dir, "auto-update.log");
  const write = createLogWriter(path, { limit: 200, now: () => new Date("2026-09-27T10:00:00.000Z") });

  write("checking for updates\n\n  \nUpdating GitHub Model Relay to 0.4.6...");
  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(lines.length, 2, "blank lines are dropped");
  assert.match(lines[0], /^2026-09-27T10:00:00\.000Z \[\d+\] checking for updates$/);

  write("x".repeat(300));
  write("after rotation");
  assert.match(readFileSync(`${path}.1`, "utf8"), /x{300}/);
  assert.match(readFileSync(path, "utf8"), /after rotation/);
  assert.ok(statSync(path).size < 200);
});

test("doctor reports the task and the last automatic update", () => {
  const ready = formatAutoUpdate(
    { name: "GitHubRelay-Update-abc", registered: true, state: "Ready", lastRun: "2026-09-27T10:00:00.0000000+05:30", lastResult: 0 },
    { lastAutoUpdate: { at: "2026-09-27T04:31:00.000Z", launcher: "0.4.6", updatedFrom: "0.4.5", result: "ok", gateway: "updated 0.4.5 -> 0.4.6" } },
    ["2026-09-27T04:30:30.000Z [1] checking for updates; launcher 0.4.5"],
  );
  assert.match(ready, /sign-in task: GitHubRelay-Update-abc, ready, last run 2026-09-27T10:00:00/);
  assert.match(ready, /launcher 0\.4\.5 -> 0\.4\.6; gateway updated 0\.4\.5 -> 0\.4\.6/);
  assert.match(ready, /checking for updates/);

  const never = formatAutoUpdate(
    { name: "GitHubRelay-Update-abc", registered: true, state: "Ready", lastRun: "1999-11-30T00:00:00.0000000", lastResult: 267011 },
    {},
  );
  assert.match(never, /not run yet/);
  assert.match(never, /none recorded yet/);

  const missing = formatAutoUpdate({ registered: false }, { updateTaskFailed: { reason: "Access is denied." } });
  assert.match(missing, /missing \(Access is denied\.\); run 'githubrelay setup'/);
});

test("the sign-in check retries a network that is still coming up", async () => {
  let calls = 0;
  const value = await withRetries(async () => {
    calls += 1;
    if (calls < 3) throw new Error("ENOTFOUND");
    return "manifest";
  }, { attempts: 8, delayMs: 1 });
  assert.equal(value, "manifest");
  assert.equal(calls, 3);

  await assert.rejects(withRetries(async () => { throw new Error("offline"); }, { attempts: 2, delayMs: 1 }), /offline/);
});
