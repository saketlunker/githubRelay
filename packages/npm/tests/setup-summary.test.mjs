import assert from "node:assert/strict";
import { test } from "node:test";

import {
  failureTail,
  parseConfigureOutput,
  releaseIdFrom,
  summarizeConfiguration,
} from "../lib/setup-summary.mjs";

const RESULT = {
  action: "configure",
  models: { claude: "claude-opus-5-5", sonnet: "claude-sonnet-5", codex: "gpt-6-astra" },
  effort: { claude: "max", codex: "max" },
  clients: [
    { client: "claude", installation: "installed" },
    { client: "codex", installation: "installed" },
    { client: "opencode", installation: "not-installed" },
    { client: "pi", installation: "installed" },
  ],
};

test("configure output is parsed even with text around the JSON", () => {
  const text = `WARNING: something\n${JSON.stringify(RESULT, null, 2)}\n`;
  assert.deepEqual(parseConfigureOutput(text), RESULT);
  assert.equal(parseConfigureOutput("no json here"), undefined);
  assert.equal(parseConfigureOutput("{ not json }"), undefined);
});

test("the summary names each agent's model and reasoning in plain words", () => {
  const lines = summarizeConfiguration(RESULT);
  assert.match(lines[0], /Claude Code\s+claude-opus-5-5 \(Sonnet slot: claude-sonnet-5\), reasoning max/);
  assert.match(lines[1], /Codex\s+gpt-6-astra, reasoning max/);
  assert.match(lines[2], /OpenCode\s+not installed; ready for when you install it/);
  assert.match(lines[3], /Pi\s+linked/);
});

test("an unpinned effort is not described as a reasoning level", () => {
  const lines = summarizeConfiguration({ ...RESULT, effort: { claude: "default", codex: "default" } });
  assert.doesNotMatch(lines.join("\n"), /reasoning/);
});

test("a missing result produces no lines rather than throwing", () => {
  assert.deepEqual(summarizeConfiguration(undefined), []);
});

test("the release id is found in install output", () => {
  assert.equal(
    releaseIdFrom("ReleaseId      : gateway-0.4.0-backend-2.0.1-e35b8150ae9d\n"),
    "gateway-0.4.0-backend-2.0.1-e35b8150ae9d",
  );
  assert.equal(releaseIdFrom("nothing"), undefined);
});

test("a failed step keeps its last meaningful lines", () => {
  const tail = failureTail({ stdout: "one\n\ntwo\n", stderr: "three\n" }, 2);
  assert.deepEqual(tail, ["two", "three"]);
});
