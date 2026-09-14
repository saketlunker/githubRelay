import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * npm 12 blocks dependency lifecycle scripts by default. Claude Code and Codex
 * both materialise their native binary in `postinstall`, so a plain
 * `npm install -g` succeeds, prints no error, and leaves a command that cannot
 * run. Detecting that is more useful than reporting "not detected".
 */
export const AGENTS = Object.freeze([
  {
    name: "Claude Code",
    packageName: "@anthropic-ai/claude-code",
    command: "claude",
    binaries: [join("bin", "claude.exe")],
    configs: [join(".claude", "settings.json"), ".claude.json"],
  },
  {
    name: "Codex",
    packageName: "@openai/codex",
    command: "codex",
    binaries: [
      join("vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"),
      join("vendor", "aarch64-pc-windows-msvc", "bin", "codex.exe"),
    ],
    configs: [join(".codex", "config.toml")],
  },
  {
    name: "OpenCode",
    packageName: "opencode-ai",
    command: "opencode",
    binaries: [],
    configs: [join(".config", "opencode", "opencode.json"), join(".config", "opencode", "opencode.jsonc")],
  },
  {
    name: "Pi",
    packageName: "@earendil-works/pi-coding-agent",
    command: "pi",
    binaries: [],
    configs: [join(".pi", "settings.json"), join(".pi", "agent", "models.json")],
  },
]);

function globalRoot() {
  return process.env.APPDATA ? join(process.env.APPDATA, "npm") : undefined;
}

/**
 * Pure so it can be tested without touching the real filesystem.
 *
 * Two different failures look alike from the outside and need different
 * remedies, so they are reported separately:
 *
 * - the package installed but its native binary is absent, which is what a
 *   blocked `postinstall` produces;
 * - the binary is present but no command was linked, which happens when npm
 *   resolves a platform-specific build that declares no `bin`.
 */
export function classifyAgent(agent, { packageInstalled, shimPresent, binaryPresent, binaryPath, configPresent }) {
  if (!packageInstalled && !shimPresent) {
    return {
      status: "not installed",
      detail: configPresent ? "relay config is ready for when you install it" : undefined,
    };
  }

  const needsBinary = agent.binaries.length > 0;

  if (needsBinary && !binaryPresent) {
    return {
      status: "installed but broken",
      detail: "its native binary is missing, which is what a blocked postinstall script leaves behind",
      fix: `npm install -g ${agent.packageName} --allow-scripts=${agent.packageName}`,
    };
  }

  if (!shimPresent) {
    return {
      status: "installed but not on PATH",
      detail: binaryPath
        ? `npm linked no ${agent.command} command for this build; the binary itself is at ${binaryPath}`
        : `npm linked no ${agent.command} command for this build`,
      fix: `run it from that path, or reinstall with: npm install -g ${agent.packageName}@latest`,
    };
  }

  if (!configPresent) {
    return {
      status: "installed, not linked to the relay",
      fix: "githubrelay clients",
    };
  }

  return { status: "ready" };
}

export function inspectAgents() {
  const home = homedir();
  const root = globalRoot();
  const report = {};

  for (const agent of AGENTS) {
    const packageDir = root ? join(root, "node_modules", ...agent.packageName.split("/")) : undefined;
    const packageInstalled = Boolean(packageDir && existsSync(packageDir));
    const shimPresent = Boolean(root && existsSync(join(root, `${agent.command}.cmd`)));

    const binaryPath = packageDir
      ? agent.binaries.map((relative) => join(packageDir, relative)).find((candidate) => existsSync(candidate))
      : undefined;
    const binaryPresent = agent.binaries.length === 0 || Boolean(binaryPath);
    const configPresent = agent.configs.some((relative) => existsSync(join(home, relative)));

    report[agent.name] = {
      ...classifyAgent(agent, { packageInstalled, shimPresent, binaryPresent, binaryPath, configPresent }),
      agent,
      binaryPath,
    };
  }

  return report;
}

/**
 * Creates the missing command for an agent that ships a working binary but was
 * installed from a build npm did not link. Without this the binary exists and
 * is unreachable, which is indistinguishable from "not installed" to a user.
 */
export function linkAgent(agent, binaryPath, { root = globalRoot() } = {}) {
  if (!root) return { ok: false, reason: "npm global directory not found" };
  if (!binaryPath || !existsSync(binaryPath)) return { ok: false, reason: "no binary to link" };

  const shim = join(root, `${agent.command}.cmd`);
  if (existsSync(shim)) return { ok: false, reason: "already linked" };

  try {
    writeFileSync(shim, `@echo off\r\n"${binaryPath}" %*\r\n`, "ascii");
    return { ok: true, path: shim };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Links every agent that is installed, has a usable binary, and has no command.
 */
export function linkUnlinkedAgents(report = inspectAgents()) {
  const linked = [];
  for (const entry of Object.values(report)) {
    if (entry.status !== "installed but not on PATH") continue;
    const result = linkAgent(entry.agent, entry.binaryPath);
    if (result.ok) linked.push({ command: entry.agent.command, path: result.path });
  }
  return linked;
}

export function formatAgents(report) {
  const lines = [];
  for (const [name, entry] of Object.entries(report)) {
    lines.push(`  ${name}: ${entry.status}`);
    if (entry.detail) lines.push(`      ${entry.detail}`);
    if (entry.fix) lines.push(`      fix: ${entry.fix}`);
  }
  return lines.join("\n");
}
