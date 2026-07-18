import { createServer } from "node:http";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { projectRoot, startIsolatedEdgeSmoke } from "./lib/isolated-edge-smoke.mjs";

const canaries = Object.freeze({
  password: "P7_PASSWORD_CANARY_8f3a",
  otp: "P7_OTP_CANARY_761904",
  recovery: "P7_RECOVERY_CANARY_Q7K2",
  captcha: "P7_CAPTCHA_CANARY_R9M4",
  cookie: "P7_COOKIE_CANARY_c31d",
  authorization: "P7_AUTH_CANARY_bearer_91e2",
  setCookie: "P7_SET_COOKIE_CANARY_57ac",
  payment: "P7_PAYMENT_CANARY_4111111111111111",
  message: "P7_MESSAGE_CANARY_full_body_62bd",
  signedQuery: "P7_SIGNED_QUERY_CANARY_3e79",
  endpoint: "ws://127.0.0.1:65530/devtools/browser/P7_CDP_CANARY",
  profile: "C:\\Users\\Fixture\\P7_PROFILE_CANARY\\primary",
});

let origin = "";
const server = createServer((request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  response.setHeader("set-cookie", `fixture=${canaries.setCookie}; HttpOnly; SameSite=Lax`);
  response.setHeader("www-authenticate", `Bearer realm="${canaries.authorization}"`);
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  if (url.pathname === "/message") {
    response.end("<!doctype html><title>Phase 7 Message Canary</title><body><form><textarea id='message'></textarea><button type='submit'>Send message</button></form></body>");
    return;
  }
  response.end(`<!doctype html><title>Phase 7 Canary</title><body>
    <form><input type="password" value="${canaries.password}"><input autocomplete="one-time-code" value="${canaries.otp}"><input name="recovery-code" value="${canaries.recovery}">
    <input name="captcha" value="${canaries.captcha}"><input autocomplete="cc-number" value="${canaries.payment}">
    </form>
    <a href="${origin}/file.pdf?signature=${canaries.signedQuery}">Signed PDF</a>
    <script>document.cookie=${JSON.stringify(`session=${canaries.cookie}; SameSite=Lax`)}</script>
  </body>`);
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const address = server.address();
if (!address || typeof address === "string") throw new Error("The canary fixture failed to bind.");
origin = `http://127.0.0.1:${address.port}`;

const runtime = await startIsolatedEdgeSmoke({ suiteName: "phase7-canary", clientName: "phase7-canary-smoke" });
const exposed = [];
const record = (label, result) => {
  for (const item of result.content || []) if (item.type === "text") exposed.push(`${label}:${item.text}`);
  const block = result.content?.find((item) => item.type === "text");
  if (!block?.text) throw new Error(`${label} returned no text payload.`);
  const value = JSON.parse(block.text);
  if (result.isError) { const error = new Error(value.message || "MCP command failed."); error.name = value.error; throw error; }
  return value;
};
const call = async (name, args = {}) => record(name, await runtime.client.callTool({ name, arguments: args }));

async function scanTextArtifacts(root) {
  const found = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "edge-profiles" || entry.name === "node_modules") continue;
        await visit(file);
      } else if (/\.(?:log|json|txt|md)$/i.test(entry.name)) {
        const content = await readFile(file, "utf8").catch(() => "");
        if (Object.values(canaries).some((value) => content.includes(value))) found.push(file);
      }
    }
  };
  await visit(root);
  return found;
}

try {
  const tabs = await call("browser_tabs");
  const sensitiveTabId = tabs.activeTabId;
  await call("browser_navigate", { tabId: sensitiveTabId, url: `${origin}/sensitive?token=${canaries.signedQuery}` });
  await call("browser_snapshot", { tabId: sensitiveTabId, maxElements: 80, maxTextCharacters: 8_000 });
  await call("browser_status");
  await call("browser_storage_summary", { tabId: sensitiveTabId });
  await runtime.client.callTool({ name: "browser_screenshot", arguments: { tabId: sensitiveTabId, scope: "viewport", maxWidth: 900 } }).then((result) => record("browser_screenshot", { ...result, content: result.content?.filter((item) => item.type === "text") || [] }));

  const tabId = (await call("browser_tab_new", { url: `${origin}/message`, activate: true })).createdTabId;
  const snapshot = await call("browser_snapshot", { tabId, maxElements: 40, maxTextCharacters: 4_000 });
  const message = snapshot.elements.find((element) => element.tag === "textarea");
  if (!message) throw new Error("The canary message field was not discovered.");
  await call("browser_act", { tabId, action: "fill", ref: message.ref, revision: snapshot.revision, text: canaries.message });
  const submit = snapshot.elements.find((element) => element.name === "Send message");
  if (!submit) throw new Error("The canary send control was not discovered.");
  const confirmation = await call("browser_act", { tabId, action: "click", ref: submit.ref, revision: snapshot.revision });
  if (!confirmation.confirmation?.id) throw new Error("The canary send action did not require confirmation.");
  await call("browser_confirmation_status", { confirmationId: confirmation.confirmation.id });
  await call("browser_status");

  const assistanceTabId = (await call("browser_tab_new", { url: `${origin}/message`, activate: false })).createdTabId;
  const assistance = await call("browser_request_assistance", {
    tabId: assistanceTabId,
    kind: "manual_action",
    title: "Fixture assistance",
    detail: `${canaries.endpoint} ${canaries.profile} Bearer ${canaries.authorization}`,
  });
  await call("browser_assistance_status", { assistanceId: assistance.id });

  const brokerLog = runtime.brokerLog();
  const artifactLeaks = [
    ...await scanTextArtifacts(path.join(projectRoot, "output")),
    ...await scanTextArtifacts(path.join(projectRoot, ".runtime")),
  ];
  const leaked = Object.entries(canaries).flatMap(([name, value]) => {
    const sources = exposed.filter((entry) => entry.includes(value)).map((entry) => entry.slice(0, entry.indexOf(":")));
    if (brokerLog.includes(value)) sources.push("broker-log");
    return sources.length ? [`${name}[${[...new Set(sources)].join("|")}]`] : [];
  });
  if (artifactLeaks.length) throw new Error(`Security canary exposure detected in ${artifactLeaks.length} generated artifact(s).`);
  if (leaked.length) throw new Error(`Security canary exposure detected in: ${leaked.join(", ")}`);
  console.log(JSON.stringify({ canariesChecked: Object.keys(canaries).length, mcpPayloadsScanned: exposed.length, brokerLogScanned: true, artifactDirectoriesScanned: 2, leaked: 0, signedUrlSanitized: true, confirmationBodyRedacted: true }, null, 2));
} finally {
  await runtime.dispose();
  await new Promise((resolve) => server.close(resolve));
}
