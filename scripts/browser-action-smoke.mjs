import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { projectRoot, startIsolatedElectronSmoke } from "./lib/isolated-electron-smoke.mjs";

function parseTextResult(result) {
  const block = result.content?.find((item) => item.type === "text");
  if (!block || typeof block.text !== "string") throw new Error("MCP tool returned no text result.");
  return JSON.parse(block.text);
}

function requireElement(snapshot, predicate, label) {
  const element = snapshot.elements.find(predicate);
  if (!element) throw new Error(`Snapshot did not contain ${label}.`);
  return element;
}

const fixtureRoot = path.join(projectRoot, "src", "renderer");
const fixture = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
    const fileName = pathname === "/auth-test.html"
      ? "auth-test.html"
      : pathname === "/interaction-test.html"
        ? "interaction-test.html"
        : null;
    if (!fileName) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    const body = await readFile(path.join(fixtureRoot, fileName));
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": body.length,
    });
    response.end(body);
  } catch (error) {
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(error instanceof Error ? error.message : String(error));
  }
});

await new Promise((resolve, reject) => {
  fixture.once("error", reject);
  fixture.listen(0, "127.0.0.1", resolve);
});
const address = fixture.address();
if (!address || typeof address === "string") throw new Error("Browser action fixture did not expose a TCP port.");
const fixtureOrigin = `http://127.0.0.1:${address.port}`;

let runtime;

try {
  runtime = await startIsolatedElectronSmoke({
    suiteName: "browser-action-smoke",
    clientName: "codex-browser-action-smoke",
  });
  const { client } = runtime;
  await client.callTool({
    name: "browser_navigate",
    arguments: { url: `${fixtureOrigin}/interaction-test.html` },
  });

  const initialSnapshot = parseTextResult(await client.callTool({ name: "browser_snapshot", arguments: {} }));
  const topic = requireElement(initialSnapshot, (item) => item.name === "Research topic", "the topic input");
  const source = requireElement(initialSnapshot, (item) => item.name === "Metadata source", "the source select");
  const run = requireElement(initialSnapshot, (item) => item.name === "Run query", "the run button");

  await client.callTool({ name: "browser_act", arguments: { action: "fill", ref: topic.ref, text: "quantum catalysis" } });
  await client.callTool({ name: "browser_act", arguments: { action: "press", ref: topic.ref, key: "Tab" } });
  const keyWait = parseTextResult(await client.callTool({
    name: "browser_wait",
    arguments: { condition: "text", value: "Key: Tab", timeoutMs: 2000 },
  }));
  if (!keyWait.satisfied) throw new Error("Keyboard action did not reach the page.");
  await client.callTool({ name: "browser_act", arguments: { action: "select", ref: source.ref, value: "openalex" } });
  await client.callTool({ name: "browser_act", arguments: { action: "click", ref: run.ref } });
  const waitResult = parseTextResult(await client.callTool({
    name: "browser_wait",
    arguments: { condition: "text", value: "Ready: quantum catalysis via openalex", timeoutMs: 3000 },
  }));
  if (!waitResult.satisfied) throw new Error("Dynamic page result did not appear.");

  const completedSnapshot = parseTextResult(await client.callTool({ name: "browser_snapshot", arguments: {} }));
  if (!completedSnapshot.text.includes("Ready: quantum catalysis via openalex")) {
    throw new Error("Completed snapshot did not contain the expected result text.");
  }
  await client.callTool({ name: "browser_act", arguments: { action: "scroll", deltaY: 1000 } });
  const scrollWait = parseTextResult(await client.callTool({
    name: "browser_wait",
    arguments: { condition: "selector", value: "body[data-scrolled='true']", timeoutMs: 2000 },
  }));
  if (!scrollWait.satisfied) throw new Error("Scroll action did not reach the page.");

  await client.callTool({
    name: "browser_navigate",
    arguments: { url: `${fixtureOrigin}/auth-test.html` },
  });
  const authSnapshot = parseTextResult(await client.callTool({ name: "browser_snapshot", arguments: {} }));
  const password = requireElement(authSnapshot, (item) => item.type === "password", "the password field");
  if (!password.sensitive) throw new Error("Password field was not marked sensitive.");

  const blocked = await client.callTool({
    name: "browser_act",
    arguments: { action: "fill", ref: password.ref, text: "must-not-be-entered" },
  });
  if (!blocked.isError) throw new Error("Sensitive password fill was not blocked.");

  console.log(JSON.stringify({
    initialElements: initialSnapshot.elements.length,
    completedText: "Ready: quantum catalysis via openalex",
    waitElapsedMs: waitResult.elapsedMs,
    keyboardEventObserved: true,
    scrollEventObserved: true,
    sensitivePasswordBlocked: true,
  }, null, 2));
} finally {
  let disposeError;
  try {
    await runtime?.dispose();
  } catch (error) {
    disposeError = error;
  }
  await new Promise((resolve) => fixture.close(resolve));
  if (disposeError) throw disposeError;
}
