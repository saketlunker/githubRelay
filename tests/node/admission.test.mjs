import assert from "node:assert/strict";
import test from "node:test";

import { AdmissionController, TokenBucket } from "../../runtime/lib/supervisor-core.mjs";

function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimer: (callback, milliseconds) => {
      const id = nextId++;
      timers.set(id, { at: now + milliseconds, callback });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    // Moves time without running timers, to reach the moment a token has
    // refilled but the wake-up timer has not fired yet.
    skip(milliseconds) {
      now += milliseconds;
    },
    advance(milliseconds) {
      const target = now + milliseconds;
      for (;;) {
        let due = null;
        for (const [id, timer] of timers) {
          if (timer.at <= target && (due === null || timer.at < due[1].at)) {
            due = [id, timer];
          }
        }
        if (due === null) {
          break;
        }
        now = due[1].at;
        timers.delete(due[0]);
        due[1].callback();
      }
      now = target;
    },
  };
}

function controller({ maxConcurrent = 1, burst = 10, requestsPerMinute = 600, maxQueued = 4, maxWaitMs = 10_000 } = {}) {
  const clock = fakeClock();
  const bucket = new TokenBucket({ requestsPerMinute, burst, now: clock.now });
  const admission = new AdmissionController({
    maxConcurrent,
    rateLimiter: bucket,
    maxQueued,
    maxWaitMs,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, bucket, admission };
}

function track(ticket) {
  const box = { settled: false, value: undefined };
  ticket.promise.then((value) => {
    box.settled = true;
    box.value = value;
  });
  return box;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("requests under the caps are admitted immediately", async () => {
  const { admission } = controller({ maxConcurrent: 2 });
  const first = track(admission.acquire());
  const second = track(admission.acquire());
  await flush();

  assert.equal(first.value.admitted, true);
  assert.equal(second.value.admitted, true);
  assert.equal(admission.activeCount, 2);
});

test("a request over the concurrency cap waits and starts when a slot frees", async () => {
  const { admission } = controller({ maxConcurrent: 1 });
  const first = track(admission.acquire());
  await flush();
  const second = track(admission.acquire());
  await flush();
  assert.equal(second.settled, false, "it must wait rather than be rejected");
  assert.equal(admission.queuedCount, 1);

  first.value.release();
  await flush();
  assert.equal(second.value.admitted, true);
  assert.equal(admission.activeCount, 1);
  assert.equal(admission.queuedCount, 0);
});

test("waiting requests start in arrival order", async () => {
  const { admission } = controller({ maxConcurrent: 1 });
  const first = track(admission.acquire());
  await flush();
  const second = track(admission.acquire());
  const third = track(admission.acquire());
  await flush();

  first.value.release();
  await flush();
  assert.equal(second.value?.admitted, true);
  assert.equal(third.settled, false);

  second.value.release();
  await flush();
  assert.equal(third.value?.admitted, true);
});

test("a full queue rejects immediately with the reason", async () => {
  const { admission } = controller({ maxConcurrent: 1, maxQueued: 1 });
  track(admission.acquire());
  track(admission.acquire());
  const overflow = track(admission.acquire());
  await flush();

  assert.equal(overflow.value.admitted, false);
  assert.equal(overflow.value.reason, "concurrency_limited");
  assert.equal(overflow.value.retryAfterSeconds, 1);
});

test("a request that waits past the limit is rejected with a retry hint", async () => {
  const { clock, admission } = controller({ maxConcurrent: 1, maxWaitMs: 1_000 });
  track(admission.acquire());
  const waiting = track(admission.acquire());
  await flush();

  clock.advance(999);
  await flush();
  assert.equal(waiting.settled, false);

  clock.advance(1);
  await flush();
  assert.equal(waiting.value.admitted, false);
  assert.equal(waiting.value.reason, "concurrency_limited");
  assert.equal(admission.queuedCount, 0);
});

test("a rejected request never spends a rate token", async () => {
  // The previous admission took a token before checking concurrency, so a
  // client retrying against a busy slot drained the bucket.
  const { bucket, admission } = controller({ maxConcurrent: 1, burst: 2, requestsPerMinute: 1, maxQueued: 0 });
  const first = track(admission.acquire());
  await flush();
  const tokensAfterFirst = bucket.tokens;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const rejected = track(admission.acquire());
    await flush();
    assert.equal(rejected.value.admitted, false);
  }
  assert.equal(bucket.tokens, tokensAfterFirst, "rejections must leave the bucket untouched");

  first.value.release();
  const next = track(admission.acquire());
  await flush();
  assert.equal(next.value.admitted, true, "the saved token is still available");
});

test("a rate-limited request waits for the next token instead of failing", async () => {
  const { clock, admission } = controller({ maxConcurrent: 4, burst: 1, requestsPerMinute: 60 });
  track(admission.acquire());
  await flush();
  const waiting = track(admission.acquire());
  await flush();
  assert.equal(waiting.settled, false);

  clock.advance(999);
  await flush();
  assert.equal(waiting.settled, false);

  clock.advance(1);
  await flush();
  assert.equal(waiting.value.admitted, true);
});

test("a cancelled request gives up its place", async () => {
  const { admission } = controller({ maxConcurrent: 1 });
  const first = track(admission.acquire());
  await flush();
  const abandoned = admission.acquire();
  const abandonedBox = track(abandoned);
  const next = track(admission.acquire());
  await flush();

  abandoned.cancel();
  await flush();
  assert.equal(abandonedBox.value.reason, "cancelled");
  assert.equal(admission.queuedCount, 1);

  first.value.release();
  await flush();
  assert.equal(next.value.admitted, true);
});

test("a new request cannot overtake one that is already waiting", async () => {
  const { clock, admission } = controller({ maxConcurrent: 4, burst: 1, requestsPerMinute: 60 });
  track(admission.acquire());
  await flush();
  const earlier = track(admission.acquire());
  await flush();

  // A token is now available, but the waiter has not been woken yet. A
  // newcomer arriving in that window must queue behind it, not take the token.
  clock.skip(1_000);
  const later = track(admission.acquire());
  await flush();
  assert.equal(earlier.value?.admitted, true, "the earlier request takes the token");
  assert.equal(later.settled, false, "the newcomer waits its turn");
});

test("releasing twice does not free two slots", async () => {
  const { admission } = controller({ maxConcurrent: 1 });
  const first = track(admission.acquire());
  await flush();
  first.value.release();
  first.value.release();
  assert.equal(admission.activeCount, 0);

  const second = track(admission.acquire());
  const third = track(admission.acquire());
  await flush();
  assert.equal(second.value.admitted, true);
  assert.equal(third.settled, false);
});
