import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createSmokeRuntime } from "./smoke-runtime.mjs";

const runtime = createSmokeRuntime("mcp-smoke");
const client = new Client({ name: "codex-browser-smoke", version: "0.1.0" });
const transport = new StdioClientTransport({ command: "node", args: [runtime.mcpServerPath], env: runtime.env });

function parseTextResult(result) {
  const block = result.content?.find((item) => item.type === "text");
  if (!block || typeof block.text !== "string") throw new Error("MCP tool returned no text result.");
  return JSON.parse(block.text);
}

try {
  await runtime.start();
  await client.connect(transport);
  const tools = await client.listTools();
  const toolNames = tools.tools.map((tool) => tool.name);
  const requiredSkillTools = [
    "browser_skill_list",
    "browser_skill_match",
    "browser_skill_run",
    "browser_skill_learn",
    "browser_skill_feedback",
  ];
  for (const name of requiredSkillTools) {
    if (!toolNames.includes(name)) throw new Error(`MCP tool list is missing ${name}.`);
  }
  const status = parseTextResult(await client.callTool({ name: "browser_status", arguments: {} }));
  if (status.browserSkills?.length !== 0 || status.browserSkillTraces?.length !== 0) {
    throw new Error("browser_status returned full skill data instead of compact counts.");
  }
  const sessionHealth = parseTextResult(await client.callTool({ name: "session_check", arguments: {} }));
  const skillLibrary = parseTextResult(await client.callTool({ name: "browser_skill_list", arguments: { includeDrafts: true } }));
  if (!Array.isArray(skillLibrary.skills)) throw new Error("browser_skill_list returned an invalid payload.");
  console.log(JSON.stringify({
    toolCount: tools.tools.length,
    tools: toolNames,
    browserSkillCount: skillLibrary.skills.length,
    status,
    sessionHealth,
  }, null, 2));
} finally {
  await client.close().catch(() => undefined);
  await runtime.stop();
}
