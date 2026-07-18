import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ExtensionRelayServer } from "../src/browser/extension-relay-server.ts";

const extensionOrigin = `chrome-extension://${"a".repeat(32)}`;

async function post(port: number, route: string, body: unknown, origin = extensionOrigin) {
  return fetch(`http://127.0.0.1:${port}${route}`, {
    method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body),
  });
}

test("relay pairing requires a user-opened window and stores only a token hash", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-browser-relay-"));
  const port = 36000 + process.pid % 2000;
  const relay = new ExtensionRelayServer(root, port);
  try {
    await relay.start();
    assert.equal((await post(port, "/pair", {})).status, 403);
    assert.equal((await post(port, "/pair", {}, "https://example.test")).status, 403);
    relay.beginPairing();
    const paired = await post(port, "/pair", {});
    assert.equal(paired.status, 200);
    const { token } = await paired.json() as { token: string };
    assert.ok(token.length >= 40);
    const authFile = readFileSync(path.join(root, "edge-relay-auth.json"), "utf8");
    assert.doesNotMatch(authFile, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(authFile, /tokenHash/);
    assert.equal((await post(port, "/exchange", { token: "wrong" })).status, 401);
    relay.enqueue({ id: 7, method: "Target.getTargets", params: {} });
    const exchange = await post(port, "/exchange", { token, responses: [], events: [] });
    const value = await exchange.json() as { commands: Array<{ id: number; method: string }> };
    assert.deepEqual(value.commands.map(({ id, method }) => ({ id, method })), [{ id: 7, method: "Target.getTargets" }]);
    assert.equal(relay.status().connected, true);
  } finally {
    await relay.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
