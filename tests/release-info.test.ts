import assert from "node:assert/strict";
import test from "node:test";
import {
  APP_VERSION,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_VERSION,
  MINIMUM_EDGE_MAJOR_VERSION,
  PROFILE_SCHEMA_VERSION,
  RELEASE_INFO,
  RUNTIME_METADATA_VERSION,
} from "../src/shared/release-info.js";
import { assertSupportedEdge, discoverEdge } from "../src/browser/edge-discovery.ts";

test("release versions are explicit and internally consistent", () => {
  assert.equal(APP_VERSION, "1.0.0");
  assert.equal(MCP_SERVER_VERSION, APP_VERSION);
  assert.equal(MCP_PROTOCOL_VERSION, "1.2.0");
  assert.equal(PROFILE_SCHEMA_VERSION, 1);
  assert.equal(RUNTIME_METADATA_VERSION, 3);
  assert.equal(MINIMUM_EDGE_MAJOR_VERSION, 109);
  assert.deepEqual(RELEASE_INFO, {
    appVersion: APP_VERSION,
    mcpServerVersion: MCP_SERVER_VERSION,
    protocolVersion: MCP_PROTOCOL_VERSION,
    profileSchemaVersion: PROFILE_SCHEMA_VERSION,
    runtimeMetadataVersion: RUNTIME_METADATA_VERSION,
    minimumEdgeMajorVersion: MINIMUM_EDGE_MAJOR_VERSION,
  });
});

test("minimum Edge compatibility fails closed", () => {
  assert.doesNotThrow(() => assertSupportedEdge({ majorVersion: MINIMUM_EDGE_MAJOR_VERSION }));
  assert.throws(
    () => assertSupportedEdge({ majorVersion: MINIMUM_EDGE_MAJOR_VERSION - 1 }),
    new RegExp(`Edge ${MINIMUM_EDGE_MAJOR_VERSION} or newer`),
  );
  assert.throws(() => assertSupportedEdge({ majorVersion: Number.NaN }), /not supported/i);
});

test("an explicit missing Edge path returns an actionable error", { skip: process.platform !== "win32" }, () => {
  assert.throws(
    () => discoverEdge({ CODEX_BROWSER_EDGE_PATH: "Z:\\missing-codex-browser-edge\\msedge.exe" }),
    /specified by the environment does not exist/i,
  );
});
