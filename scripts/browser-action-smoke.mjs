import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const launcher = "C:\\Users\\22865\\plugins\\codex-browser\\scripts\\launch-mcp.mjs";
const env = Object.fromEntries(Object.entries(process.env).filter((entry) => typeof entry[1] === "string"));
env.CODEX_BROWSER_PROJECT_ROOT = "A:\\Project\\CodexBrowser";

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

const client = new Client({ name: "codex-browser-action-smoke", version: "0.1.0" });
const transport = new StdioClientTransport({ command: "node", args: [launcher], env });

try {
  await client.connect(transport);
  await client.callTool({
    name: "browser_navigate",
    arguments: { url: "http://127.0.0.1:5173/interaction-test.html" },
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
    arguments: { url: "http://127.0.0.1:5173/auth-test.html" },
  });
  const authSnapshot = parseTextResult(await client.callTool({ name: "browser_snapshot", arguments: {} }));
  const password = requireElement(authSnapshot, (item) => item.type === "password", "the password field");
  if (!password.sensitive) throw new Error("Password field was not marked sensitive.");

  const blocked = await client.callTool({
    name: "browser_act",
    arguments: { action: "fill", ref: password.ref, text: "must-not-be-entered" },
  });
  if (!blocked.isError) throw new Error("Sensitive password fill was not blocked.");

  await client.callTool({ name: "browser_resume", arguments: {} });
  await client.callTool({ name: "browser_navigate", arguments: { url: "about:blank" } });

  console.log(JSON.stringify({
    initialElements: initialSnapshot.elements.length,
    completedText: "Ready: quantum catalysis via openalex",
    waitElapsedMs: waitResult.elapsedMs,
    keyboardEventObserved: true,
    scrollEventObserved: true,
    sensitivePasswordBlocked: true,
  }, null, 2));
} finally {
  await client.close();
}
