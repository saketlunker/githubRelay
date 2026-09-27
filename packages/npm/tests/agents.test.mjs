import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  AGENTS,
  CLAUDE_CODE_INSTALL,
  CODEX_INSTALL,
  agentInstallCommand,
  claudeCodeUpgradeNeeded,
  classifyAgent,
  findOnPath,
  formatAgents,
} from "../lib/agents.mjs";

const claude = AGENTS.find((agent) => agent.command === "claude");
const codex = AGENTS.find((agent) => agent.command === "codex");
const pi = AGENTS.find((agent) => agent.command === "pi");

test("a fully working agent reports ready", () => {
  const result = classifyAgent(claude, {
    packageInstalled: true,
    shimPresent: true,
    binaryPresent: true,
    configPresent: true,
  });

  assert.equal(result.status, "ready");
  assert.equal(result.fix, undefined);
});

test("a missing native binary is reported as broken with the exact fix", () => {
  // What a blocked postinstall produces: the package installs, the command
  // exists, and it cannot run because the binary was never placed.
  const result = classifyAgent(claude, {
    packageInstalled: true,
    shimPresent: true,
    binaryPresent: false,
    configPresent: true,
  });

  assert.equal(result.status, "installed but broken");
  assert.match(result.detail, /postinstall/);
  assert.equal(
    result.fix,
    "npm install -g @anthropic-ai/claude-code@latest --allow-remote=all --allow-scripts=@anthropic-ai/claude-code",
  );
});

test("a present binary with no linked command is a different problem", () => {
  // Observed with @openai/codex@0.154.0-alpha.3-win32-x64, a platform build
  // that declares no bin and no scripts. Recommending --allow-scripts here
  // would send the user down a path that cannot work.
  const result = classifyAgent(codex, {
    packageInstalled: true,
    shimPresent: false,
    binaryPresent: true,
    binaryPath: "C:\\npm\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe",
    configPresent: true,
  });

  assert.equal(result.status, "installed but not on PATH");
  assert.match(result.detail, /codex\.exe/, "the working binary path must be shown");
  assert.doesNotMatch(result.fix, /--allow-scripts/, "allow-scripts cannot fix a package with no scripts");
  assert.match(result.fix, /githubrelay clients/, "re-linking creates the missing command");
});

test("an installed agent without relay config is told to run clients", () => {
  const result = classifyAgent(claude, {
    packageInstalled: true,
    shimPresent: true,
    binaryPresent: true,
    configPresent: false,
  });

  assert.equal(result.status, "installed, not linked to the relay");
  assert.equal(result.fix, "githubrelay clients");
});

test("an absent agent is not reported as broken", () => {
  const result = classifyAgent(claude, {
    packageInstalled: false,
    shimPresent: false,
    binaryPresent: false,
    configPresent: false,
  });

  assert.equal(result.status, "not installed");
  assert.equal(result.fix, undefined);
});

test("config written ahead of install is noted rather than treated as a problem", () => {
  const result = classifyAgent(claude, {
    packageInstalled: false,
    shimPresent: false,
    binaryPresent: false,
    configPresent: true,
  });

  assert.equal(result.status, "not installed");
  assert.match(result.detail, /ready for when you install it/);
});

test("agents with no native binary are not failed for missing one", () => {
  const result = classifyAgent(pi, {
    packageInstalled: true,
    shimPresent: true,
    binaryPresent: true,
    configPresent: true,
  });

  assert.equal(result.status, "ready");
});

test("the formatted report shows the fix under the agent", () => {
  const text = formatAgents({
    "Claude Code": { status: "installed but broken", detail: "binary missing", fix: "npm install -g x" },
    Codex: { status: "ready" },
  });

  assert.match(text, /Claude Code: installed but broken/);
  assert.match(text, /fix: npm install -g x/);
  assert.match(text, /Codex: ready/);
});

test("a Claude Code build too old for the configured model is caught", () => {
  // The exact case observed: Opus 5.5 is refused below 2.1.280.
  const upgrade = claudeCodeUpgradeNeeded("2.1.278", ["claude-opus-5-5", "claude-sonnet-5"]);
  assert.deepEqual(upgrade, { model: "claude-opus-5-5", required: "2.1.280", version: "2.1.278" });

  assert.equal(claudeCodeUpgradeNeeded("2.1.283", ["claude-opus-5-5"]), undefined);
  assert.equal(claudeCodeUpgradeNeeded("2.1.200", ["claude-sonnet-5"]), undefined, "no minimum, no warning");
  assert.equal(claudeCodeUpgradeNeeded(undefined, ["claude-opus-5-5"]), undefined, "an unreadable version is not guessed at");
});

test("an outdated Claude Code is reported with the installer that fixes it", () => {
  const result = classifyAgent(claude, {
    packageInstalled: true,
    shimPresent: true,
    binaryPresent: true,
    configPresent: true,
    upgrade: { model: "claude-opus-5-5", required: "2.1.280", version: "2.1.278" },
  });

  assert.equal(result.status, "update needed");
  assert.match(result.detail, /2\.1\.278 is too old for claude-opus-5-5/);
  assert.equal(result.fix, CLAUDE_CODE_INSTALL);
});

test("an agent install command works on any network", () => {
  // Observed on a Microsoft network: without --allow-remote, npm refused the
  // corporate mirror's tarball with EALLOWREMOTE; without --allow-scripts,
  // Claude Code installed without its binary.
  const command = agentInstallCommand("@openai/codex");
  assert.equal(command, "npm install -g @openai/codex@latest --allow-remote=all --allow-scripts=@openai/codex");
});

test("Codex is recommended from OpenAI's own release rather than an npm tag", () => {
  // A Microsoft npm mirror tagged a platform-only alpha build as `latest`.
  assert.equal(CODEX_INSTALL, "winget install --id OpenAI.Codex -e");
});

test("an agent installed outside npm is found on PATH", () => {
  const directory = mkdtempSync(join(tmpdir(), "githubrelay-path-"));
  try {
    writeFileSync(join(directory, "claude.exe"), "");
    assert.equal(findOnPath("claude", { PATH: directory }), join(directory, "claude.exe"));
    assert.equal(findOnPath("codex", { PATH: directory }), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
