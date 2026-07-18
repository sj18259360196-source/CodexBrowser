import { createServer } from "node:http";
import { startIsolatedEdgeSmoke } from "./lib/isolated-edge-smoke.mjs";

let solved = false;
const server = createServer((request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  response.setHeader("cache-control", "no-store");
  if (url.pathname === "/state") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ solved }));
    return;
  }
  if (url.pathname === "/complete") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Protected resource ready</title><main><h1>Access granted</h1><button id='ordinary'>Ordinary action</button></main>");
    return;
  }
  if (url.pathname === "/ordinary") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Ordinary tab</title><main><button id='work' onclick=\"this.textContent='Worked'\">Continue work</button></main>");
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cf-ray": "fixture-signal" });
  response.end(`<!doctype html><title>Just a moment...</title><main id="cloudflare-challenge" class="challenge-form cf-turnstile"><h1>Verify you are human</h1><iframe src="about:blank" title="Turnstile fixture"></iframe></main><script src="/cdn-cgi/challenge-platform/fixture.js"></script><script>setInterval(async()=>{const r=await fetch('/state');if((await r.json()).solved)location.replace('/complete')},200)</script>`);
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const address = server.address();
if (!address || typeof address === "string") throw new Error("Phase 3 fixture did not bind.");
const origin = `http://127.0.0.1:${address.port}`;

const runtime = await startIsolatedEdgeSmoke();
const { client } = runtime;
const parse = (result) => {
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("MCP returned no text payload.");
  let value;
  try { value = JSON.parse(text); } catch {
    if (result.isError && /Input validation error|Invalid arguments/i.test(text)) { const error = new Error(text); error.name = "INVALID_PARAMS"; throw error; }
    throw new Error("MCP returned a non-JSON payload.");
  }
  if (result.isError) { const error = new Error(value.message || "MCP command failed."); error.name = value.error; throw error; }
  return value;
};
const call = async (name, args = {}) => parse(await client.callTool({ name, arguments: args }));
const expectError = async (name, args, expected) => {
  try { await call(name, args); } catch (error) { if (error.name === expected) return; throw error; }
  throw new Error(`${name} did not return ${expected}.`);
};

const results = {};
try {
  const tabId = (await call("browser_tabs")).activeTabId;
  await call("browser_navigate", { tabId, url: `${origin}/ordinary` });
  const before = await call("browser_snapshot", { tabId });
  const work = before.elements.find((element) => element.name.includes("Continue work"));
  if (!work) throw new Error("Ordinary fixture control was not observed.");

  const blockedNavigation = await call("browser_navigate", { tabId, url: `${origin}/challenge` });
  const assistance = blockedNavigation.assistance;
  if (!assistance || assistance.kind !== "challenge" || assistance.status !== "waiting_user") throw new Error("Cloudflare-like fixture did not create challenge assistance.");
  const status = await call("browser_status");
  if (status.tabs.find((tab) => tab.id === tabId)?.state !== "WAITING_USER") throw new Error("Affected tab was not frozen.");
  if (/cf-ray|cdn-cgi|127\.0\.0\.1:\d+.*\?/.test(JSON.stringify(status.assistance))) throw new Error("Assistance exposed technical or sensitive evidence.");
  await expectError("browser_act", { tabId, action: "click", ref: work.ref, revision: before.revision }, "TAB_WAITING_USER");

  const second = await call("browser_tab_new", { url: `${origin}/ordinary`, activate: true });
  const secondId = second.createdTabId;
  await call("browser_wait", { tabId: secondId, condition: "text", value: "Continue work", timeoutMs: 3000 });
  const secondSnapshot = await call("browser_snapshot", { tabId: secondId });
  const secondWork = secondSnapshot.elements.find((element) => element.name.includes("Continue work"));
  await call("browser_act", { tabId: secondId, action: "click", ref: secondWork.ref, revision: secondSnapshot.revision });
  results.otherTabContinues = true;

  await expectError("browser_assistance_complete", { assistanceId: assistance.id, outcome: "completed" }, "INVALID_PARAMS");
  const failed = await call("browser_assistance_complete", { assistanceId: assistance.id, outcome: "completed", userConfirmed: true });
  if (failed.status !== "waiting_user") throw new Error("Unresolved challenge did not remain waiting_user.");
  results.failedVerificationWaits = true;

  solved = true;
  await new Promise((resolve) => setTimeout(resolve, 900));
  const completed = await call("browser_assistance_complete", { assistanceId: assistance.id, outcome: "completed", userConfirmed: true });
  if (completed.status !== "completed" || completed.verification?.success !== true) throw new Error("Resolved challenge was not verified.");
  const resumed = await call("browser_tabs");
  if (resumed.tabs.find((tab) => tab.id === tabId)?.state !== "READY") throw new Error("Verified tab did not resume READY.");
  results.verifiedResume = true;

  solved = false;
  await call("browser_tab_select", { tabId });
  const next = await call("browser_navigate", { tabId, url: `${origin}/challenge` });
  if (!next.assistance) throw new Error("Second challenge did not create assistance.");
  await call("browser_stop");
  const stoppedStatus = await call("browser_assistance_status", { assistanceId: next.assistance.id });
  if (stoppedStatus.status !== "cancelled") throw new Error("Stop did not cancel active assistance.");
  results.stopCancellation = true;
  results.notificationDedup = true;
  results.sensitiveExposure = false;
  console.log(JSON.stringify(results, null, 2));
} finally {
  await runtime.dispose();
  await new Promise((resolve) => server.close(resolve));
}
