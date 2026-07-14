import assert from "node:assert/strict";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createSmokeRuntime, projectRoot } from "./smoke-runtime.mjs";

if (process.platform !== "win32") throw new Error("The packaged runtime smoke currently supports Windows only.");

const packagedExecutable = path.join(projectRoot, "release", "win-unpacked", "Codex Browser.exe");
const runtime = createSmokeRuntime("packaged-runtime-smoke");
const client = new Client({ name: "codex-browser-packaged-smoke", version: "0.1.1" });
const transport = new StdioClientTransport({ command: "node", args: [runtime.mcpServerPath], env: runtime.env });

function parseTextResult(result) {
  const block = result.content?.find((item) => item.type === "text");
  if (!block || typeof block.text !== "string") throw new Error("MCP tool returned no text result.");
  return JSON.parse(block.text);
}

try {
  await runtime.start({ executable: packagedExecutable, args: [] });
  await client.connect(transport);
  const capabilities = parseTextResult(await client.callTool({ name: "browser_capabilities", arguments: {} }));
  const status = parseTextResult(await client.callTool({ name: "browser_status", arguments: {} }));
  assert.equal(capabilities.protocolVersion, "1.3.0", "The packaged app exposed an unexpected protocol version.");
  assert.equal(status.protocolVersion, "1.3.0", "The packaged status exposed an unexpected protocol version.");
  assert.ok(Array.isArray(capabilities.capabilities), "The packaged app returned invalid capabilities.");
  console.log(JSON.stringify({
    executable: packagedExecutable,
    protocolVersion: status.protocolVersion,
    capabilityCount: capabilities.capabilities.length,
    profileIsolated: true,
  }, null, 2));
} finally {
  await client.close().catch(() => undefined);
  await runtime.stop();
}
