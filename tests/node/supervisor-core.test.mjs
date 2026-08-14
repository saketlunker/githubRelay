import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  JsonlLogger,
  TokenBucket,
  assertLoopbackAddress,
  constantTimeEqual,
  isAllowedApiPath,
  isAllowedOrigin,
  redactText,
  resolveInside,
  restartDelayMilliseconds,
} from "../../runtime/lib/supervisor-core.mjs";

const testOutput = path.resolve(import.meta.dirname, "..", "..", ".test-output");

test("security helpers fail closed", () => {
  assert.equal(assertLoopbackAddress("127.0.0.1"), "127.0.0.1");
  assert.throws(() => assertLoopbackAddress("0.0.0.0"), /non-loopback/);
  assert.equal(constantTimeEqual("same-value", "same-value"), true);
  assert.equal(constantTimeEqual("same-value", "different"), false);
  assert.equal(isAllowedOrigin(undefined), true);
  assert.equal(isAllowedOrigin("https://localhost:1234"), true);
  assert.equal(isAllowedOrigin("https://attacker.example"), false);
  assert.equal(isAllowedApiPath("/v1/messages?beta=true"), true);
  assert.equal(isAllowedApiPath("/provider/v1/responses"), true);
  assert.equal(isAllowedApiPath("/token"), false);
  assert.equal(isAllowedApiPath("/admin/config"), false);
});

test("rate limiter and restart backoff are bounded", () => {
  let now = 0;
  const bucket = new TokenBucket({
    requestsPerMinute: 60,
    burst: 2,
    now: () => now,
  });
  assert.equal(bucket.take().allowed, true);
  assert.equal(bucket.take().allowed, true);
  assert.equal(bucket.take().allowed, false);
  now = 1_000;
  assert.equal(bucket.take().allowed, true);

  assert.equal(restartDelayMilliseconds(0, 1_000, 60_000, () => 0.5), 1_000);
  assert.equal(
    restartDelayMilliseconds(20, 1_000, 60_000, () => 0.5),
    60_000,
  );
});

test("redaction removes known and patterned secrets", () => {
  const secret = "abcdefghijklmnopqrstuvwxyz012345";
  const output = redactText(
    `Authorization: Bearer abc x-api-key=${secret} token=gho_123456789012345678901234`,
    [secret],
  );
  assert.doesNotMatch(output, /abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(output, /gho_/);
  assert.match(output, /REDACTED/);
});

test("path resolution cannot escape an immutable release", () => {
  const root = path.resolve("example", "release");
  assert.equal(
    resolveInside(root, path.join("runtime", "supervisor.mjs")),
    path.resolve(root, "runtime", "supervisor.mjs"),
  );
  assert.throws(() => resolveInside(root, path.join("..", "outside.mjs")), /escapes/);
  assert.throws(() => resolveInside(root, path.resolve("outside.mjs")), /relative/);
});

test("structured logger rotates and never writes known secrets", (t) => {
  mkdirSync(testOutput, { recursive: true });
  const directory = mkdtempSync(path.join(testOutput, "chg-logger-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "supervisor.jsonl");
  const secret = "known-secret-value-1234567890";
  const logger = new JsonlLogger({
    file,
    maximumFileBytes: 65_536,
    retainedFiles: 2,
    knownSecrets: [secret],
  });
  for (let index = 0; index < 700; index += 1) {
    logger.write("info", "test.event", {
      message: `${secret} ${"x".repeat(100)}`,
    });
  }
  const active = readFileSync(file, "utf8");
  assert.doesNotMatch(active, new RegExp(secret));
  assert.match(active, /REDACTED/);
});
