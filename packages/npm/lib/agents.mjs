import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import { compareVersions, runCommandSync } from "./environment.mjs";

// Newer Claude models are refused server-side for older Claude Code builds.
// Observed on claude-opus-5-5 with 2.1.278: "Claude Code 2.1.278 does not
// support this model; version 2.1.280 or newer is required".
export const CLAUDE_CODE_MINIMUMS = Object.freeze({
  "claude-opus-5-5": "2.1.280",
});

// Claude Code's own installer ships builds ahead of npm, which is where the
// version Opus 5.5 needs first appeared, and it updates itself.
export const CLAUDE_CODE_INSTALL = "irm https://claude.ai/install.ps1 | iex";

// winget installs OpenAI's own GitHub release build, so it is current on any
// network that reaches GitHub. Through a Microsoft npm mirror, the `latest` tag
// of @openai/codex resolved to 0.156.0-alpha.9-win32-x64, a platform-only
// alpha build with no command, while the stable release was 0.157.1.
export const CODEX_INSTALL = "winget install --id OpenAI.Codex -e";

/**
 * An npm install command for a coding agent that works on any network.
 *
 * Both flags are needed. npm 12 blocks the postinstall step that places an
 * agent's native binary unless it is allowed, and a corporate npm mirror
 * serves tarballs from another host, which npm refuses by default. Without
 * --allow-remote the command failed with EALLOWREMOTE on a Microsoft network.
 */
export function agentInstallCommand(packageName) {
  return `npm install -g ${packageName}@latest --allow-remote=all --allow-scripts=${packageName}`;
}

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
 * The first executable Windows would run for `command`. Agents are not only
 * installed through npm: Claude Code's own installer puts a native build in
 * %USERPROFILE%\.local\bin, which an npm-only check reported as missing.
 */
export function findOnPath(command, env = process.env) {
  const directories = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  for (const directory of directories) {
    for (const extension of [".exe", ".cmd", ".bat"]) {
      const candidate = join(directory, `${command}${extension}`);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/** The first configured Claude model the given Claude Code build cannot use. */
export function claudeCodeUpgradeNeeded(version, models, minimums = CLAUDE_CODE_MINIMUMS) {
  if (typeof version !== "string") {
    return undefined;
  }
  for (const model of models) {
    const required = minimums[model];
    if (required !== undefined && compareVersions(version, required) < 0) {
      return { model, required, version };
    }
  }
  return undefined;
}

function claudeCodeVersion(commandPath) {
  const options = { encoding: "utf8", timeout: 20_000, windowsHide: true };
  // A .cmd shim cannot be spawned directly, and `shell: true` with arguments
  // prints Node 24's DEP0190 warning and splits a path containing spaces.
  const probe = /\.(cmd|bat)$/i.test(commandPath)
    ? runCommandSync(commandPath, ["--version"], options)
    : spawnSync(commandPath, ["--version"], options);
  return /(\d+\.\d+\.\d+)/.exec(`${probe.stdout ?? ""}`)?.[1];
}

function configuredClaudeModels(home) {
  try {
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    return [
      settings.model,
      settings.env?.ANTHROPIC_DEFAULT_OPUS_MODEL,
      settings.env?.ANTHROPIC_DEFAULT_SONNET_MODEL,
    ].filter((value) => typeof value === "string");
  } catch {
    return [];
  }
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
export function classifyAgent(agent, {
  packageInstalled,
  shimPresent,
  binaryPresent,
  binaryPath,
  configPresent,
  upgrade,
}) {
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
      fix: agentInstallCommand(agent.packageName),
    };
  }

  if (!shimPresent) {
    return {
      status: "installed but not on PATH",
      detail: binaryPath
        ? `npm linked no ${agent.command} command for this build; the binary itself is at ${binaryPath}`
        : `npm linked no ${agent.command} command for this build`,
      fix: "githubrelay clients, which links the command for you",
    };
  }

  if (!configPresent) {
    return {
      status: "installed, not linked to the relay",
      fix: "githubrelay clients",
    };
  }

  if (upgrade !== undefined) {
    return {
      status: "update needed",
      detail: `version ${upgrade.version} is too old for ${upgrade.model}, which needs ${upgrade.required} or newer; requests on it are refused`,
      fix: CLAUDE_CODE_INSTALL,
    };
  }

  return { status: "ready" };
}

export function inspectAgents({ checkVersions = true } = {}) {
  const home = homedir();
  const root = globalRoot();
  const report = {};

  for (const agent of AGENTS) {
    const packageDir = root ? join(root, "node_modules", ...agent.packageName.split("/")) : undefined;
    const packageInstalled = Boolean(packageDir && existsSync(packageDir));
    const commandPath = findOnPath(agent.command);
    // Installed by something other than npm, such as Claude Code's own
    // installer. It is judged by the command that actually runs.
    const installedElsewhere = !packageInstalled && commandPath !== undefined;
    const shimPresent = Boolean(root && existsSync(join(root, `${agent.command}.cmd`))) || commandPath !== undefined;

    const binaryPath = packageDir
      ? agent.binaries.map((relative) => join(packageDir, relative)).find((candidate) => existsSync(candidate))
      : undefined;
    const binaryPresent = agent.binaries.length === 0 || Boolean(binaryPath) || installedElsewhere;
    const configPresent = agent.configs.some((relative) => existsSync(join(home, relative)));

    const upgrade = checkVersions && agent.command === "claude" && commandPath !== undefined
      ? claudeCodeUpgradeNeeded(claudeCodeVersion(commandPath), configuredClaudeModels(home))
      : undefined;

    report[agent.name] = {
      ...classifyAgent(agent, {
        packageInstalled: packageInstalled || installedElsewhere,
        shimPresent,
        binaryPresent,
        binaryPath,
        configPresent,
        upgrade,
      }),
      agent,
      binaryPath,
      commandPath,
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
export function linkUnlinkedAgents(report = inspectAgents({ checkVersions: false })) {
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
