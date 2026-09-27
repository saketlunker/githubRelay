import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  isAllowedApiPath,
  isAllowedOrigin,
  requestApiKey,
} from "../../runtime/lib/supervisor-core.mjs";

const fixture = JSON.parse(readFileSync(
  new URL("../fixtures/external-relay-protocol.json", import.meta.url),
  "utf8",
));

// Inspect complete fixture records only; this is not a client SSE implementation.
function fixtureData(wire) {
  return wire.replaceAll("\r\n", "\n").split("\n\n").flatMap((record) => {
    const lines = record.split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""));
    return lines.length > 0 ? [lines.join("\n")] : [];
  });
}

test("contract fixtures identify their sources without carrying credentials", () => {
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.fictional, true);
  assert.equal(fixture.backendVersion, "2.0.1");
  assert.match(fixture.relaySourceSha, /^[0-9a-f]{40}$/);
  assert.match(fixture.backendSourceSha, /^[0-9a-f]{40}$/);
  assert.equal(fixture.request.headers.authorization, undefined);
  assert.equal(fixture.request.headers["x-api-key"], undefined);
  assert.equal(fixture.request.headers.origin, undefined);
  assert.equal(fixture.cancellation.publicCancelEndpoint, null);
});

test("sample routes and native Origin match the shipped proxy helpers", () => {
  assert.equal(isAllowedApiPath(fixture.request.path), true);
  assert.equal(isAllowedApiPath("/v1/models"), true);
  assert.equal(isAllowedApiPath("/chat/completions"), false);
  assert.equal(isAllowedApiPath("/v1/cancel"), false);
  assert.equal(isAllowedOrigin(fixture.request.headers.origin), true);
  assert.equal(isAllowedOrigin("https://example.invalid"), false);
});

test("local key header precedence is explicit", () => {
  assert.equal(requestApiKey({}), "");
  assert.equal(requestApiKey({ authorization: "Bearer fixture-bearer" }), "fixture-bearer");
  assert.equal(requestApiKey({ authorization: "bearer fixture-bearer" }), "fixture-bearer");
  assert.equal(requestApiKey({
    "x-api-key": "fixture-local",
    authorization: "Bearer fixture-bearer",
  }), "fixture-local");
  assert.equal(requestApiKey({
    "x-api-key": "",
    authorization: "Bearer fixture-bearer",
  }), "fixture-bearer");
});

test("health samples distinguish readiness from missing backend prerequisites", () => {
  for (const sample of fixture.health) {
    assert.equal(sample.status, sample.body.status === "ready" ? 200 : 503);
    assert.equal(typeof sample.body.backendReady, "boolean");
    assert.deepEqual(Object.keys(sample.body).sort(), [
      "activeVersionId", "backendReady", "instanceId", "status",
    ]);
  }
});

test("catalog samples preserve numeric token limits and unsupported cases", () => {
  const catalog = fixture.catalog;
  assert.equal(catalog.object, "list");
  assert.equal(catalog.has_more, false);
  const byId = new Map(catalog.data.map((model) => [model.id, model]));
  assert.equal(byId.size, catalog.data.length);
  assert.equal(byId.get("fixture-chat").capabilities.limits.max_output_tokens, 64);
  assert.equal(byId.get("fixture-chat").capabilities.limits.max_context_window_tokens, 8192);
  assert.deepEqual(byId.get("fixture-chat").supported_endpoints, ["/chat/completions"]);
  assert.deepEqual(byId.get("fixture-responses-only").supported_endpoints, ["/responses"]);
  assert.equal(byId.get("fixture-disabled").policy.state, "disabled");
  assert.equal(byId.get("fixture-unknown-capabilities").supported_endpoints, undefined);
  assert.ok(byId.has("fixture-provider/fixture-chat"));
});

for (const sample of fixture.streams) {
  test(`SSE vector is internally consistent: ${sample.name}`, () => {
    let text = "";
    let finishReason = null;
    let done = false;
    let malformed = false;
    let upstreamError = false;
    for (const data of fixtureData(sample.wire)) {
      if (data === "[DONE]") {
        done = true;
        break;
      }
      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch (error) {
        assert.ok(error instanceof SyntaxError);
        malformed = true;
        break;
      }
      if (chunk.error !== undefined) {
        upstreamError = true;
        break;
      }
      assert.ok(Array.isArray(chunk.choices));
      for (const choice of chunk.choices) {
        if (choice.index !== 0) continue;
        if (typeof choice.delta.content === "string") text += choice.delta.content;
        if (choice.finish_reason != null) finishReason = choice.finish_reason;
      }
    }
    assert.equal(text, sample.expected.text);
    assert.equal(finishReason, sample.expected.finishReason);
    assert.equal(done, sample.expected.done);
    assert.equal(malformed, sample.expected.outcome === "invalid_stream");
    assert.equal(upstreamError, sample.expected.outcome === "upstream_error");
    if (sample.expected.outcome === "truncated_stream") assert.equal(done, false);
  });
}

test("UTF-8 vector survives every two-chunk byte boundary", () => {
  const sample = fixture.streams.find((entry) => entry.name === "text-usage-crlf-multiline-utf8");
  const bytes = Buffer.from(sample.wire, "utf8");
  assert.ok(bytes.includes(0xc3));
  assert.match(sample.wire, /\r\n/);
  assert.match(sample.wire, /\r\ndata: "choices"/);
  for (let split = 1; split < bytes.length; split += 1) {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const decoded = decoder.decode(bytes.subarray(0, split), { stream: true })
      + decoder.decode(bytes.subarray(split));
    assert.equal(decoded, sample.wire, `UTF-8 split at byte ${split}`);
  }
});

test("errors cover both envelopes and bounded retry hints", () => {
  for (const sample of fixture.errors) {
    assert.ok(sample.status >= 400 && sample.status <= 599);
    if (sample.origin === "proxy") {
      assert.equal(typeof sample.body.error, "string");
    } else {
      assert.equal(typeof sample.body.error.message, "string");
      assert.equal(sample.body.error.type, "error");
    }
    if (sample.status === 429) {
      assert.match(sample.headers["retry-after"], /^[1-9]\d*$/);
    }
  }
});
