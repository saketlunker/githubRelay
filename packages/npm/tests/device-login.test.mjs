import assert from "node:assert/strict";
import { test } from "node:test";

import { createDeviceLoginWatcher } from "../lib/device-login.mjs";

// Exactly what the backend printed during a real sign-in.
const REAL_LINE =
  'ℹ Please enter the code "9294-C6A2" in https://github.com/login/device                    7:08:09 pm';

function harness() {
  const copied = [];
  const opened = [];
  const said = [];
  const watcher = createDeviceLoginWatcher({
    announce: (line) => said.push(line),
    copy: (code) => {
      copied.push(code);
      return true;
    },
    open: (url) => {
      opened.push(url);
      return true;
    },
  });
  return { watcher, copied, opened, said };
}

test("the device code is copied and the verification page is opened", () => {
  const { watcher, copied, opened, said } = harness();
  watcher(REAL_LINE);

  assert.deepEqual(copied, ["9294-C6A2"]);
  assert.deepEqual(opened, ["https://github.com/login/device"]);
  assert.ok(said.some((line) => line.includes("clipboard")));
});

test("only the first code triggers the browser", () => {
  const { watcher, copied, opened } = harness();
  watcher(REAL_LINE);
  watcher('Please enter the code "ABCD-1234" in https://github.com/login/device');

  assert.equal(copied.length, 1, "a retry must not reopen the browser");
  assert.equal(opened.length, 1);
});

test("unrelated output is ignored", () => {
  const { watcher, copied, opened } = harness();
  for (const line of [
    "ℹ Logging in with GitHub Copilot",
    "added 151 packages in 5s",
    "ReleaseId      : gateway-0.2.2-backend-2.0.1-98009c3f606b",
    "Status        Note",
  ]) {
    watcher(line);
  }

  assert.equal(copied.length, 0);
  assert.equal(opened.length, 0);
});

test("a code without a URL still falls back to the GitHub device page", () => {
  const { watcher, copied, opened } = harness();
  watcher('enter the code "WXYZ-7788" to continue');

  assert.deepEqual(copied, ["WXYZ-7788"]);
  assert.deepEqual(opened, ["https://github.com/login/device"]);
});

test("failure to copy still tells the user the code", () => {
  const said = [];
  const watcher = createDeviceLoginWatcher({
    announce: (line) => said.push(line),
    copy: () => false,
    open: () => false,
  });
  watcher(REAL_LINE);

  assert.ok(said.some((line) => line.includes("9294-C6A2")), "the code must remain visible");
});
