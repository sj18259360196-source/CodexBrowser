import assert from "node:assert/strict";
import test from "node:test";
import { isSupportedNodeVersion } from "../scripts/check-node-version.mjs";

test("accepts the minimum Node version and newer major versions", () => {
  assert.equal(isSupportedNodeVersion("22.13.0"), true);
  assert.equal(isSupportedNodeVersion("v22.14.1"), true);
  assert.equal(isSupportedNodeVersion("24.15.0"), true);
  assert.equal(isSupportedNodeVersion("30.0.0"), true);
});

test("rejects older and malformed Node versions", () => {
  assert.equal(isSupportedNodeVersion("22.12.9"), false);
  assert.equal(isSupportedNodeVersion("21.99.0"), false);
  assert.equal(isSupportedNodeVersion("not-a-version"), false);
  assert.equal(isSupportedNodeVersion(""), false);
});
