import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const launcher = "C:\\Users\\22865\\plugins\\codex-browser\\scripts\\launch-mcp.mjs";
const env = Object.fromEntries(
  Object.entries(process.env).filter((entry) => typeof entry[1] === "string"),
);
env.CODEX_BROWSER_PROJECT_ROOT = "A:\\Project\\CodexBrowser";

const client = new Client({ name: "codex-browser-smoke", version: "0.1.0" });
const transport = new StdioClientTransport({ command: "node", args: [launcher], env });

function parseTextResult(result) {
  const block = result.content?.find((item) => item.type === "text");
  if (!block || typeof block.text !== "string") throw new Error("MCP tool returned no text result.");
  return JSON.parse(block.text);
}

try {
  await client.connect(transport);
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
  await client.close();
}
