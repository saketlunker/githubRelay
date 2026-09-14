import assert from "node:assert/strict";
import { test } from "node:test";

import { AGENTS, classifyAgent, formatAgents } from "../lib/agents.mjs";

const claude = AGENTS.find((agent) => agent.command === "claude");
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
  // What npm 12 actually produces: the package installs, postinstall is
  // blocked, and the command exists but cannot run.
  const result = classifyAgent(claude, {
    packageInstalled: true,
    shimPresent: true,
    binaryPresent: false,
    configPresent: true,
  });

  assert.equal(result.status, "installed but broken");
  assert.match(result.detail, /postinstall/);
  assert.equal(result.fix, "npm install -g @anthropic-ai/claude-code --allow-scripts=@anthropic-ai/claude-code");
});

test("a package with no linked command is reported as broken", () => {
  const result = classifyAgent(claude, {
    packageInstalled: true,
    shimPresent: false,
    binaryPresent: true,
    configPresent: true,
  });

  assert.equal(result.status, "installed but broken");
  assert.match(result.fix, /--allow-scripts/);
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
