import assert from "node:assert/strict";
import { test } from "node:test";

import { scrubText } from "../lib/doctor.mjs";

test("ANSI colour codes are stripped from diagnostics", () => {
  const coloured = "\u001B[31;1mException: install failed\u001B[0m";
  const scrubbed = scrubText(coloured);

  assert.equal(scrubbed, "Exception: install failed");
  assert.ok(!scrubbed.includes("\u001B"), "escape sequences must not reach a pasted report");
});

test("stripping colour does not damage surrounding text", () => {
  const scrubbed = scrubText("\u001B[32mport 4141 ready\u001B[0m on 127.0.0.1");
  assert.equal(scrubbed, "port 4141 ready on 127.0.0.1");
});
