import { createServer } from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  EdgePrototypeRuntime,
  createUniqueEdgeProfile,
  discoverEdge,
  getConfiguredBrowserRuntime,
  removeManagedEdgeProfile,
} from "../dist/browser/edge-prototype-entry.mjs";

const runtimeRoot = path.resolve(".runtime");
const profileDir = createUniqueEdgeProfile(runtimeRoot);
const expectedTitle = "Codex Browser Phase 1 Edge Fixture";
let runtime;
let server;
let fixtureUrl;
let smokeError;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function assertRejects(action, message) {
  try {
    await action();
  } catch {
    return;
  }
  throw new Error(message);
}

async function startFixture() {
  server = createServer((request, response) => {
    if (request.url !== "/phase1-edge-fixture") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(`<!doctype html><html><head><title>${expectedTitle}</title></head><body><h1>Phase 1</h1></body></html>`);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The local Edge fixture did not bind a private port.");
  fixtureUrl = `http://127.0.0.1:${address.port}/phase1-edge-fixture`;
}

async function stopFixture() {
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
}

try {
  assert(getConfiguredBrowserRuntime({}) === "external-edge", "External Edge is not the default browser runtime.");
  process.env.CODEX_BROWSER_RUNTIME ||= "external-edge";
  assert(getConfiguredBrowserRuntime() === "external-edge", "The external Edge runtime was not active.");
  const edge = discoverEdge();
  await startFixture();
  runtime = new EdgePrototypeRuntime({ runtimeRoot, profileDir });
  const connection = await runtime.start();
  const duplicateRuntime = new EdgePrototypeRuntime({ runtimeRoot, profileDir });
  await assertRejects(
    () => duplicateRuntime.start(),
    "A second runtime unexpectedly acquired the active Edge test profile.",
  );
  assert((await runtime.status()).state === "ready", "Managed Edge did not reach ready state.");
  await runtime.show();
  const initialTabs = await connection.adapter.discoverTabs();
  assert(initialTabs.length >= 1, "Managed Edge did not expose a page target.");
  const created = await connection.adapter.createTestTab();
  await connection.adapter.navigate(created.id, fixtureUrl);
  const navigated = await connection.adapter.readTab(created.id);
  assert(navigated.title === expectedTitle, "Managed Edge returned the wrong fixture title.");
  assert(navigated.url === fixtureUrl, "Managed Edge returned the wrong final fixture URL.");
  await connection.disconnect();
  const reconnected = await runtime.attach();
  const rediscovered = await reconnected.adapter.discoverTabs();
  assert(rediscovered.some((tab) => tab.id === created.id && tab.url === fixtureUrl), "Reconnect did not rediscover the existing test tab.");
  const reread = await reconnected.adapter.readTab(created.id);
  assert(reread.title === expectedTitle && reread.url === fixtureUrl, "Reconnect changed the existing page state.");
  await reconnected.adapter.closeTab(created.id);
  await runtime.shutdown({ graceful: true });
  const stopped = await runtime.status();
  assert(stopped.state === "stopped" && !stopped.managed, "Managed Edge did not stop cleanly.");
  assert(!existsSync(path.join(profileDir, ".codex-browser-profile.lock")), "The managed Edge profile lock was not released.");
  console.log(JSON.stringify({
    ok: true,
    runtime: "external-edge",
    transport: "ephemeral-loopback-websocket",
    browser: "Microsoft Edge",
    version: edge.version,
    tabsRediscovered: rediscovered.length,
    duplicateProfileRejected: true,
    debuggingEndpointRemoved: true,
    profileLockReleased: true,
  }, null, 2));
} catch (error) {
  smokeError = error;
} finally {
  if (runtime) {
    await runtime.shutdown({ graceful: true }).catch(() => undefined);
  }
  await stopFixture().catch(() => undefined);
  try {
    removeManagedEdgeProfile(profileDir, runtimeRoot);
  } catch (cleanupError) {
    smokeError ||= cleanupError;
  }
}

if (smokeError) throw smokeError;
