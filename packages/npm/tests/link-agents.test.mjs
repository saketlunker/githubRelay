import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AGENTS, linkAgent, linkUnlinkedAgents } from "../lib/agents.mjs";

const codex = AGENTS.find((agent) => agent.command === "codex");

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "githubrelay-link-"));
  const binary = join(dir, "codex.exe");
  writeFileSync(binary, "");
  return { dir, binary };
}

test("a missing command is created for a working binary", () => {
  const { dir, binary } = workspace();
  try {
    const result = linkAgent(codex, binary, { root: dir });

    assert.equal(result.ok, true);
    assert.ok(existsSync(result.path));
    assert.match(readFileSync(result.path, "utf8"), /codex\.exe" %\*/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an existing command is never overwritten", () => {
  const { dir, binary } = workspace();
  try {
    const shim = join(dir, "codex.cmd");
    writeFileSync(shim, "original");

    const result = linkAgent(codex, binary, { root: dir });

    assert.equal(result.ok, false);
    assert.equal(readFileSync(shim, "utf8"), "original", "a real npm shim must survive");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nothing is linked when there is no binary", () => {
  const { dir } = workspace();
  try {
    const result = linkAgent(codex, join(dir, "absent.exe"), { root: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /no binary/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only agents in the unlinked state are touched", () => {
  const linked = linkUnlinkedAgents({
    Ready: { status: "ready", agent: codex, binaryPath: "C:\\nope.exe" },
    Absent: { status: "not installed", agent: codex, binaryPath: undefined },
    Broken: { status: "installed but broken", agent: codex, binaryPath: undefined },
  });

  assert.deepEqual(linked, [], "a healthy or absent agent must not be rewritten");
});
