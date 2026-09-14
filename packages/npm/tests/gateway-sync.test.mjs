import assert from "node:assert/strict";
import { test } from "node:test";

import { gatewayNeedsUpdate, parseGatewayVersion } from "../lib/gateway-sync.mjs";

// The exact shape the gateway reports.
const RELEASE = "gateway-0.2.2-backend-2.0.1-98009c3f606b";

test("the gateway version is read out of the release id", () => {
  assert.equal(parseGatewayVersion(RELEASE), "0.2.2");
});

test("an older gateway is upgraded to the launcher's payload", () => {
  assert.equal(gatewayNeedsUpdate(RELEASE, "0.2.7"), true);
});

test("a matching gateway is left alone", () => {
  assert.equal(gatewayNeedsUpdate(RELEASE, "0.2.2"), false);
});

test("a newer gateway is never downgraded", () => {
  assert.equal(gatewayNeedsUpdate("gateway-0.3.0-backend-2.0.1-abc", "0.2.7"), false);
});

test("an unrecognisable release id is left alone rather than guessed at", () => {
  for (const value of ["", undefined, null, "something-else", "gateway-backend-2.0.1"]) {
    assert.equal(gatewayNeedsUpdate(value, "0.2.7"), false, `must not act on: ${value}`);
  }
});

test("prerelease gateway versions parse without breaking comparison", () => {
  assert.equal(parseGatewayVersion("gateway-0.3.0-rc.1-backend-2.0.1-abc"), "0.3.0-rc.1");
  assert.equal(gatewayNeedsUpdate("gateway-0.2.9-backend-2.0.1-abc", "0.2.10"), true);
});
