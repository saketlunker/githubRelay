import assert from "node:assert/strict";
import { test } from "node:test";

import { compareVersions } from "../lib/environment.mjs";
import { scrubText, scrubValue } from "../lib/doctor.mjs";

test("version comparison orders releases correctly", () => {
  assert.equal(compareVersions("0.2.3", "0.2.2"), 1);
  assert.equal(compareVersions("0.2.2", "0.2.3"), -1);
  assert.equal(compareVersions("0.2.2", "0.2.2"), 0);
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
});

test("diagnostics redact secret-shaped values", () => {
  const token = `gho_${"a".repeat(36)}`;
  const hex = "f".repeat(64);
  const scrubbed = scrubText(`token=${token} digest=${hex}`);

  assert.ok(!scrubbed.includes(token), "OAuth token must not survive redaction");
  assert.ok(!scrubbed.includes(hex), "long hex secrets must not survive redaction");
  assert.ok(scrubbed.includes("<redacted>"));
});

test("diagnostics redact by key name even when the value looks harmless", () => {
  const scrubbed = scrubValue({
    publicApiKey: "abc",
    nested: { adminToken: "xyz", port: 4141 },
    safeField: "loopback",
  });

  assert.equal(scrubbed.publicApiKey, "<redacted>");
  assert.equal(scrubbed.nested.adminToken, "<redacted>");
  assert.equal(scrubbed.nested.port, 4141);
  assert.equal(scrubbed.safeField, "loopback");
});

test("redaction walks arrays without dropping entries", () => {
  const scrubbed = scrubValue([{ apiKey: "secret" }, { port: 4142 }]);
  assert.equal(scrubbed.length, 2);
  assert.equal(scrubbed[0].apiKey, "<redacted>");
  assert.equal(scrubbed[1].port, 4142);
});
