import assert from "node:assert/strict";
import { test } from "node:test";

import { withRetries } from "../lib/update.mjs";

test("a transient failure is retried and then succeeds", async () => {
  let calls = 0;
  const result = await withRetries(
    async () => {
      calls += 1;
      // Exactly what the network produced: an intermittent gateway timeout.
      if (calls < 3) throw new Error("HTTP 504 for https://github.com/...");
      return "ok";
    },
    { attempts: 4 },
  );

  assert.equal(result, "ok");
  assert.equal(calls, 3);
});

test("a persistent failure still surfaces the original error", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetries(
        async () => {
          calls += 1;
          throw new Error("HTTP 404 for https://github.com/...");
        },
        { attempts: 2 },
      ),
    /HTTP 404/,
  );

  assert.equal(calls, 2, "it must stop after the configured attempts");
});

test("a first-try success does not retry", async () => {
  let calls = 0;
  const result = await withRetries(async () => {
    calls += 1;
    return "immediate";
  });

  assert.equal(result, "immediate");
  assert.equal(calls, 1);
});

test("each retry is reported so a slow update does not look frozen", async () => {
  const seen = [];
  await withRetries(
    async () => {
      if (seen.length < 2) throw new Error("HTTP 504");
      return "ok";
    },
    { attempts: 4, onRetry: (attempt) => seen.push(attempt) },
  );

  assert.deepEqual(seen, [1, 2]);
});
