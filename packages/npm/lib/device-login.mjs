import { spawn } from "node:child_process";

import { isWindows } from "./environment.mjs";

// GitHub device codes look like ABCD-1234; the backend prints them quoted.
const DEVICE_CODE = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/;
const DEVICE_URL = /(https:\/\/[^\s"']*github\.com\/login\/device)/i;

export function copyToClipboard(text) {
  if (!isWindows()) return false;
  try {
    const child = spawn("clip", [], { stdio: ["pipe", "ignore", "ignore"], shell: true });
    child.stdin.end(text);
    return true;
  } catch {
    return false;
  }
}

export function openBrowser(url) {
  if (!isWindows()) return false;
  try {
    // The empty title argument is required; `start "url"` would treat the URL
    // as a window title and open a blank console instead.
    spawn("cmd.exe", ["/d", "/s", "/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Watches device-login output and, the first time a code appears, copies it and
 * opens the verification page so the code can be pasted straight in.
 */
export function createDeviceLoginWatcher({
  announce = console.error,
  copy = copyToClipboard,
  open = openBrowser,
} = {}) {
  let handled = false;

  return function onLine(line) {
    if (handled) return;

    const code = DEVICE_CODE.exec(line)?.[1];
    if (!code) return;

    const url = DEVICE_URL.exec(line)?.[1] ?? "https://github.com/login/device";
    handled = true;

    const copied = copy(code);
    const opened = open(url);

    announce("");
    if (copied && opened) {
      announce(`  Code ${code} is copied to your clipboard.`);
      announce(`  Your browser is opening ${url} -- just paste and confirm.`);
    } else if (copied) {
      announce(`  Code ${code} is copied to your clipboard.`);
      announce(`  Open ${url} and paste it.`);
    } else {
      announce(`  Enter code ${code} at ${url}`);
    }
    announce("");
  };
}

export { DEVICE_CODE, DEVICE_URL };
