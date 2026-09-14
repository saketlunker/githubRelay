import { spawnSync } from "node:child_process";

import {
  MINIMUM_NODE,
  PACKAGE_NAME,
  compareVersions,
  isWindows,
  payloadInstalled,
  resolvePowerShell,
} from "./environment.mjs";

function check(name, ok, detail, fix) {
  return { name, ok, detail, fix };
}

function nodeCheck() {
  const current = process.versions.node;
  if (compareVersions(current, MINIMUM_NODE) >= 0) {
    return check("Node.js", true, `v${current}`);
  }
  return check(
    "Node.js",
    false,
    `v${current} is too old; ${MINIMUM_NODE} or newer is required`,
    "Install the current Node.js LTS from https://nodejs.org/en/download, reopen your terminal, then re-run setup.",
  );
}

function npmCheck() {
  const probe = spawnSync("npm", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    shell: isWindows(),
  });
  if (!probe.error && probe.status === 0) {
    return check("npm", true, `v${(probe.stdout ?? "").trim()}`);
  }
  return check(
    "npm",
    false,
    "not found on PATH",
    "npm ships with Node.js. Reinstall Node.js from https://nodejs.org/en/download and reopen your terminal.",
  );
}

function powerShellCheck() {
  const shell = resolvePowerShell();
  if (shell) {
    return check("PowerShell", true, `${shell.command} (v${shell.majorVersion})`);
  }
  return check(
    "PowerShell",
    false,
    "not found",
    "Windows 10/11 includes Windows PowerShell 5.1. If it was removed, install PowerShell 7 from https://aka.ms/powershell.",
  );
}

function platformCheck() {
  if (isWindows()) {
    return check("Operating system", true, `${process.platform}-${process.arch}`);
  }
  return check(
    "Operating system",
    false,
    `${process.platform}-${process.arch} is not supported yet`,
    `The npm installer currently supports Windows only. On macOS and Linux, clone https://github.com/saketlunker/githubRelay and run the desktop app instead.`,
  );
}

function payloadCheck() {
  if (payloadInstalled()) {
    return check("Relay payload", true, "present");
  }
  return check(
    "Relay payload",
    false,
    "missing from the installed package",
    `Reinstall with: npm install -g ${PACKAGE_NAME}@latest`,
  );
}

export function runPreflight() {
  const checks = [platformCheck(), nodeCheck(), npmCheck(), powerShellCheck(), payloadCheck()];
  return { checks, ok: checks.every((entry) => entry.ok) };
}

export function formatPreflight({ checks }) {
  const lines = [];
  for (const entry of checks) {
    lines.push(`  ${entry.ok ? "[ok]" : "[!!]"} ${entry.name}: ${entry.detail}`);
    if (!entry.ok && entry.fix) {
      lines.push(`       fix: ${entry.fix}`);
    }
  }
  return lines.join("\n");
}
