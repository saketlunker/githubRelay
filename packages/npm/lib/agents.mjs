import { existsSync } from "node:fs";
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
 */
export function classifyAgent(agent, { packageInstalled, shimPresent, binaryPresent, configPresent }) {
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
      detail: "its native binary is missing, which happens when npm blocks postinstall scripts",
      fix: `npm install -g ${agent.packageName} --allow-scripts=${agent.packageName}`,
    };
  }

  if (!shimPresent) {
    return {
      status: "installed but broken",
      detail: `the ${agent.command} command was never linked, which happens when npm blocks postinstall scripts`,
      fix: `npm install -g ${agent.packageName} --allow-scripts=${agent.packageName}`,
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
    const binaryPresent =
      agent.binaries.length === 0 ||
      (packageDir ? agent.binaries.some((relative) => existsSync(join(packageDir, relative))) : false);
    const configPresent = agent.configs.some((relative) => existsSync(join(home, relative)));

    report[agent.name] = classifyAgent(agent, { packageInstalled, shimPresent, binaryPresent, configPresent });
  }

  return report;
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
