import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createSmokeRuntime, projectRoot } from "./smoke-runtime.mjs";

const runtime = createSmokeRuntime("skill-runtime-smoke");
const userDataDir = runtime.profileDir;

const builtServicePath = path.join(projectRoot, "dist", "electron", "browser-skill-service.js");
const serviceModule = await import(`${pathToFileURL(builtServicePath).href}?runtime-smoke=${Date.now()}`);
const BrowserSkillService = serviceModule.BrowserSkillService ?? serviceModule.default?.BrowserSkillService;
if (!BrowserSkillService) throw new Error("The built browser skill service export is missing.");

function parseTextResult(result) {
  const block = result.content?.find((item) => item.type === "text");
  if (!block || typeof block.text !== "string") throw new Error("MCP tool returned no text result.");
  return JSON.parse(block.text);
}

const fixture = createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html>
    <html lang="en">
      <head><meta charset="utf-8"><title>Support queue</title></head>
      <body>
        <main>
          <h1>Support queue</h1>
          <label>Queue search <input aria-label="Queue search" placeholder="Search requests"></label>
          <button type="button" aria-label="Apply filters">Apply filters</button>
          <p id="result">No filter applied</p>
        </main>
        <script>
          document.querySelector('button').addEventListener('click', () => {
            document.getElementById('result').textContent = 'Applied: ' + document.querySelector('input').value;
          });
        </script>
      </body>
    </html>`);
});

await new Promise((resolve, reject) => {
  fixture.once("error", reject);
  fixture.listen(0, "127.0.0.1", resolve);
});
const address = fixture.address();
if (!address || typeof address === "string") throw new Error("Unable to determine fixture port.");
const fixtureUrl = `http://127.0.0.1:${address.port}/skill-run`;

const timestamp = new Date().toISOString();
const service = new BrowserSkillService(userDataDir);
await service.initialize();
const skill = await service.saveSkill({
  schemaVersion: 1,
  id: "support-queue-filter",
  name: "Filter support queue",
  description: "Generic form workflow used to verify browser-native skills.",
  status: "disabled",
  risk: "interaction",
  trigger: { hosts: ["127.0.0.1"], pathPatterns: ["/skill-run"], keywords: ["support", "filter"] },
  inputs: [{ name: "input_query", label: "Queue query", type: "text", required: true, sensitive: false }],
  steps: [
    { id: "step-001", label: "Open queue", method: "browser.navigate", params: { url: fixtureUrl }, risk: "read_only" },
    {
      id: "step-002",
      label: "Fill queue search",
      method: "browser.act",
      params: { action: "fill", text: "{{input_query}}" },
      target: { tag: "input", role: "textbox", name: "Queue search", placeholder: "Search requests" },
      risk: "interaction",
    },
    {
      id: "step-003",
      label: "Apply filters",
      method: "browser.act",
      params: { action: "click" },
      target: { tag: "button", role: "button", name: "Apply filters" },
      risk: "interaction",
    },
    { id: "step-004", label: "Verify result", method: "browser.wait", params: { condition: "text", value: "Applied: {{input_query}}", timeoutMs: 3_000 }, risk: "read_only" },
  ],
  stats: { runCount: 0, successCount: 0, failureCount: 0, averageDurationMs: 0 },
  source: "manual",
  version: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
});
await service.setStatus(skill.id, "enabled");

const client = new Client({ name: "codex-browser-skill-runtime-smoke", version: "0.1.0" });
const transport = new StdioClientTransport({ command: "node", args: [runtime.mcpServerPath], env: runtime.env });
const learnedSecret = "private-runtime-skill-value-019f5ffa40a27c01";

try {
  await runtime.start();
  await client.connect(transport);
  const matches = parseTextResult(await client.callTool({
    name: "browser_skill_match",
    arguments: { query: "Filter urgent support requests", url: fixtureUrl },
  }));
  assert.equal(matches.matches[0]?.id, skill.id, "The enabled generic skill did not match its host, path, and keywords.");

  const run = parseTextResult(await client.callTool({
    name: "browser_skill_run",
    arguments: { skillId: skill.id, inputs: { input_query: "urgent" } },
  }));
  assert.equal(run.status, "done", `Browser skill run failed: ${run.detail}`);
  const observation = parseTextResult(await client.callTool({ name: "browser_observe", arguments: {} }));
  assert.match(observation.text, /Applied: urgent/, "The skill did not produce the expected page result.");

  await client.callTool({ name: "browser_navigate", arguments: { url: fixtureUrl } });
  const snapshot = parseTextResult(await client.callTool({ name: "browser_snapshot", arguments: {} }));
  const input = snapshot.elements.find((element) => element.name === "Queue search");
  const button = snapshot.elements.find((element) => element.name === "Apply filters");
  assert.ok(input?.ref && button?.ref, "The fixture controls were not captured semantically.");
  await client.callTool({
    name: "browser_act",
    arguments: { action: "fill", ref: input.ref, text: learnedSecret, revision: snapshot.revision },
  });
  await client.callTool({
    name: "browser_act",
    arguments: { action: "click", ref: button.ref, revision: snapshot.revision },
  });
  await client.callTool({
    name: "browser_wait",
    arguments: { condition: "text", value: `Applied: ${learnedSecret}`, timeoutMs: 3_000 },
  });
  const learned = parseTextResult(await client.callTool({
    name: "browser_skill_learn",
    arguments: { name: "Learned support filter", description: "Learned from a generic browser task." },
  }));
  assert.equal(learned.skill?.status, "draft");
  assert.ok(learned.skill?.steps.length >= 4, "The recorded browser task did not create replayable steps.");
  assert.equal(JSON.stringify(learned).includes(learnedSecret), false, "The learned skill response exposed the raw filled value.");

  const stored = await Promise.all([
    fs.readFile(path.join(userDataDir, "browser-skills", "skills.json"), "utf8"),
    fs.readFile(path.join(userDataDir, "browser-skills", "traces.json"), "utf8"),
  ]).then((items) => items.join("\n"));
  assert.equal(stored.includes(learnedSecret), false, "The browser skill store persisted a raw filled value.");

  console.log(JSON.stringify({
    matchedSkill: matches.matches[0].name,
    runStatus: run.status,
    semanticResultVerified: true,
    learnedDraftSteps: learned.skill.steps.length,
    rawFilledValueAbsent: true,
  }, null, 2));
} finally {
  await client.close().catch(() => undefined);
  await new Promise((resolve) => fixture.close(resolve));
  await runtime.stop();
}
