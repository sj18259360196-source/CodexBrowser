import { startIsolatedElectronSmoke } from "./lib/isolated-electron-smoke.mjs";

function parseTextResult(result) {
  const block = result.content?.find((item) => item.type === "text");
  if (!block || typeof block.text !== "string") throw new Error("MCP tool returned no text result.");
  return JSON.parse(block.text);
}

const runtime = await startIsolatedElectronSmoke({
  suiteName: "mcp-smoke",
  clientName: "codex-browser-smoke",
});
const { client } = runtime;

try {
  const tools = await client.listTools();
  const status = parseTextResult(await client.callTool({ name: "browser_status", arguments: {} }));
  const sessionHealth = parseTextResult(await client.callTool({ name: "session_check", arguments: {} }));
  console.log(JSON.stringify({
    toolCount: tools.tools.length,
    tools: tools.tools.map((tool) => tool.name),
    status,
    sessionHealth,
  }, null, 2));
} finally {
  await runtime.dispose();
}
