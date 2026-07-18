import { createServer } from "node:http";
import { startIsolatedEdgeSmoke } from "./lib/isolated-edge-smoke.mjs";

const server = createServer((request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  if (url.pathname === "/stale") {
    response.end(`<!doctype html><title>Policy stale fixture</title><main><section><h1>Messages</h1><form method="post"><button id="stale" type="submit" data-effect="stale">Send message</button></form><output id="stale-count">0</output></section></main><script>
      addEventListener('submit',event=>{event.preventDefault();const id=event.submitter?.dataset.effect;if(id){const out=document.getElementById(id+'-count');out.textContent=String(Number(out.textContent)+1)}});
      setTimeout(()=>{document.querySelector('h1').textContent='Actions';document.getElementById('stale').textContent='Continue'},1200);
    </script>`);
    return;
  }
  response.end(`<!doctype html><title>Phase 5 local policy fixture</title><main>
    <section><h1>Search and filter</h1><input aria-label="Search query"><button type="button" id="search" onclick="mark('search')">Search</button><form method="post"><button type="submit" data-effect="filter">Delete search filter</button></form><output id="search-count">0</output><output id="filter-count">0</output></section>
    <section><h2>Messages</h2><form method="post"><button type="submit" data-effect="send">Send message</button></form><output id="send-count">0</output></section>
    <section><h2>Publish article</h2><form method="post"><button type="submit" data-effect="publish">Publish article</button></form><output id="publish-count">0</output></section>
    <section><h2>Records</h2><form method="post"><button type="submit" data-effect="delete">Delete record</button></form><output id="delete-count">0</output></section>
    <section><h2>Checkout and payment</h2><p>Total USD 12.00</p><form method="post"><button type="submit" data-effect="payment">Pay now</button></form><output id="payment-count">0</output></section>
    <script>
      function mark(id){const out=document.getElementById(id+'-count');out.textContent=String(Number(out.textContent)+1)}
      addEventListener('submit',event=>{event.preventDefault();const id=event.submitter?.dataset.effect;if(id)mark(id)});
    </script>
  </main>`);
});

await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const address = server.address();
if (!address || typeof address === "string") throw new Error("Phase 5 fixture failed to bind.");
const origin = `http://127.0.0.1:${address.port}`;

let runtime;
let stage = "startup";
const parse = (result) => {
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("MCP returned no text payload.");
  let value;
  try { value = JSON.parse(text); } catch {
    const error = new Error(text);
    error.name = result.isError ? "INVALID_PARAMS" : "INVALID_RESPONSE";
    throw error;
  }
  if (result.isError) { const error = new Error(value.message || "MCP command failed."); error.name = value.error; throw error; }
  return value;
};
const call = async (name, args = {}) => parse(await runtime.client.callTool({ name, arguments: args }));
const expectError = async (fn, expected) => {
  try { await fn(); } catch (error) { if (expected.includes(error.name)) return error; throw error; }
  throw new Error(`Expected one of ${expected.join(", ")}.`);
};
const snapshot = (tabId) => call("browser_snapshot", { tabId, maxElements: 100, maxTextCharacters: 8_000 });
const find = (page, name) => {
  const element = page.elements.find((item) => item.name === name || item.name.includes(name));
  if (!element) throw new Error(`Fixture element not found: ${name}`);
  return element;
};
const act = (tabId, page, element, action = "click") => call("browser_act", { tabId, action, ref: element.ref, revision: page.revision });
const count = async (tabId, marker) => {
  const observed = await call("browser_observe", { tabId, maxCharacters: 8_000 });
  const match = observed.text.match(new RegExp(`${marker}\\s*(\\d+)`, "i"));
  return match ? Number(match[1]) : 0;
};

try {
  runtime = await startIsolatedEdgeSmoke({ suiteName: "policy", clientName: "policy-confirmation-smoke" });
  const tabId = (await call("browser_tabs")).activeTabId;
  await call("browser_navigate", { tabId, url: `${origin}/` });

  stage = "ordinary actions";
  let page = await snapshot(tabId);
  const search = await act(tabId, page, find(page, "Search"));
  if (search.confirmation) throw new Error("Ordinary search unexpectedly required confirmation.");
  page = await snapshot(tabId);
  const filter = await act(tabId, page, find(page, "Delete search filter"));
  if (filter.confirmation) throw new Error("Deleting a search filter was misclassified as external deletion.");

  stage = "one-time communication confirmation";
  page = await snapshot(tabId);
  const sendRequest = await act(tabId, page, find(page, "Send message"));
  const sendConfirmation = sendRequest.confirmation;
  if (!sendConfirmation || sendConfirmation.category !== "communication") throw new Error("Sending a message did not create the expected confirmation.");
  if (await count(tabId, "Send message") !== 0) throw new Error("Message side effect occurred before approval.");
  await expectError(() => call("browser_confirmation_respond", { confirmationId: sendConfirmation.id, response: "allow_once" }), ["INVALID_PARAMS", "TRUSTED_UI_REQUIRED"]);
  const completed = await runtime.rawCall("policy.respond_confirmation", { confirmationId: sendConfirmation.id, response: "allow_once" });
  if (completed.status !== "completed") throw new Error("Trusted one-time approval did not complete.");
  await expectError(() => runtime.rawCall("policy.respond_confirmation", { confirmationId: sendConfirmation.id, response: "allow_once" }), ["CONFIRMATION_STALE"]);

  stage = "temporary grant";
  page = await snapshot(tabId);
  const publishRequest = await act(tabId, page, find(page, "Publish article"));
  await runtime.rawCall("policy.respond_confirmation", { confirmationId: publishRequest.confirmation.id, response: "allow_temporary" });
  const grants = await call("browser_grants_list");
  if (!grants.some((grant) => grant.origin === origin && grant.category === "publication" && grant.tabId === tabId)) throw new Error("Scoped publication grant was not created.");
  page = await snapshot(tabId);
  const grantedPublish = await act(tabId, page, find(page, "Publish article"));
  if (grantedPublish.confirmation) throw new Error("Matching scoped grant did not authorize the same category.");

  stage = "denial";
  page = await snapshot(tabId);
  const deleteRequest = await act(tabId, page, find(page, "Delete record"));
  await call("browser_confirmation_respond", { confirmationId: deleteRequest.confirmation.id, response: "deny" });
  if (await count(tabId, "Delete record") !== 0) throw new Error("Denied deletion was executed.");

  stage = "high-risk grant rejection";
  page = await snapshot(tabId);
  const paymentRequest = await act(tabId, page, find(page, "Pay now"));
  await expectError(() => runtime.rawCall("policy.respond_confirmation", { confirmationId: paymentRequest.confirmation.id, response: "allow_temporary" }), ["GRANT_NOT_ALLOWED"]);
  if (await count(tabId, "Pay now") !== 0) throw new Error("Payment executed before grant eligibility was rejected.");
  await runtime.rawCall("policy.respond_confirmation", { confirmationId: paymentRequest.confirmation.id, response: "allow_once" });

  stage = "stale page revalidation";
  await call("browser_navigate", { tabId, url: `${origin}/stale` });
  page = await snapshot(tabId);
  const staleRequest = await act(tabId, page, find(page, "Send message"));
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  await expectError(() => runtime.rawCall("policy.respond_confirmation", { confirmationId: staleRequest.confirmation.id, response: "allow_once" }), ["STALE_CONFIRMATION"]);
  if (await count(tabId, "Send message") !== 0) throw new Error("Stale confirmed action executed after page context changed.");

  stage = "stop cancellation";
  await call("browser_navigate", { tabId, url: `${origin}/` });
  page = await snapshot(tabId);
  const stopRequest = await act(tabId, page, find(page, "Send message"));
  await call("browser_stop");
  const stopped = await call("browser_confirmation_status", { confirmationId: stopRequest.confirmation.id });
  if (stopped.status !== "cancelled") throw new Error("Stop did not cancel the pending confirmation.");
  await expectError(() => runtime.rawCall("policy.respond_confirmation", { confirmationId: stopRequest.confirmation.id, response: "allow_once" }), ["CONFIRMATION_STALE"]);

  const status = await call("browser_status");
  const publicOutput = JSON.stringify({ status, grants: await call("browser_grants_list"), confirmations: await call("browser_confirmation_status") });
  if (/password-secret|otp-secret|authorization|set-cookie|devtoolsactiveport|websocket/i.test(publicOutput)) throw new Error("Policy MCP output exposed forbidden sensitive or transport data.");

  console.log(JSON.stringify({
    ordinaryAllowed: true,
    confirmationRequired: true,
    mcpCannotApprove: true,
    executionOnce: true,
    denialPreventsExecution: true,
    scopedGrant: true,
    paymentGrantRejectedBeforeExecution: true,
    staleRevalidation: true,
    stopCancellation: true,
  }, null, 2));
} catch (error) {
  throw new Error(`Phase 5 policy smoke failed during ${stage}: ${error instanceof Error ? `${error.name}: ${error.message}` : "unknown error"}`);
} finally {
  if (runtime) await runtime.dispose().catch(() => undefined);
  await new Promise((resolve) => server.close(resolve));
}
