import { startIsolatedEdgeSmoke } from "./lib/isolated-edge-smoke.mjs";

const fullMatrix = [
  { category: "static", url: "https://example.com/", expect: "ready" },
  { category: "search", url: "https://www.bing.com/search?q=codex+browser+release+acceptance", expect: "ready" },
  { category: "documentation", url: "https://developer.mozilla.org/en-US/docs/Web/HTML", expect: "ready" },
  { category: "cookie-capable", url: "https://httpbin.org/cookies/set/codex_phase7/public-fixture", expect: "ready" },
  { category: "login-entry", url: "https://github.com/login", expect: "human-boundary" },
  { category: "sso-entry", url: "https://login.microsoftonline.com/", expect: "human-boundary" },
  { category: "challenge-demo", url: "https://nowsecure.nl/", expect: "human-boundary" },
  { category: "pdf", url: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf", expect: "ready" },
  { category: "download", url: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf", expect: "ready", workflow: "download-pdf" },
  { category: "iframe", url: "https://www.w3.org/WAI/UA/TS/html401/cp0101/0101-IFRAME.html", expect: "ready" },
];
const requestedCategories = new Set(String(process.env.CODEX_BROWSER_PUBLIC_CATEGORIES || "").split(",").map((value) => value.trim()).filter(Boolean));
const matrix = requestedCategories.size ? fullMatrix.filter((item) => requestedCategories.has(item.category)) : fullMatrix;

const runtime = await startIsolatedEdgeSmoke({ suiteName: "phase7-public", clientName: "phase7-public-site-acceptance" });
const parse = (result) => {
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("MCP returned no text payload.");
  const value = JSON.parse(text);
  if (result.isError) { const error = new Error(value.message || "MCP command failed."); error.name = value.error; throw error; }
  return value;
};
const call = async (name, args = {}) => parse(await runtime.client.callTool({ name, arguments: args }));
const results = [];
function safeFailureClass(error) {
  const message = String(error?.message || "");
  if (/ERR_(?:NAME_NOT_RESOLVED|CONNECTION|TIMED_OUT|TUNNEL|INTERNET)|network/i.test(message)) return "NETWORK_UNAVAILABLE";
  if (/closed|missing|stale|unavailable/i.test(message)) return "PAGE_UNAVAILABLE";
  if (/timeout|timed out/i.test(message)) return "TIMEOUT";
  return String(error?.name || "BROWSER_ERROR").replace(/[^A-Z0-9_]/gi, "_").slice(0, 48);
}

try {
  for (const item of matrix) {
    console.error(`[public-acceptance] ${item.category}: start`);
    const created = await call("browser_tab_new", { url: "about:blank", activate: false });
    const tabId = created.createdTabId;
    let outcome = "ready";
    let reason = "none";
    try {
      await call("browser_navigate", { tabId, url: item.url });
      const tabs = await call("browser_tabs");
      const tab = tabs.tabs.find((candidate) => candidate.id === tabId);
      if (["WAITING_USER", "VERIFYING"].includes(tab?.state)) outcome = "human-boundary";
      else if (item.workflow === "download-pdf") {
        const candidates = await call("paper_find_downloads", { tabId });
        const candidate = candidates.find((entry) => entry.kind === "loaded_pdf" || /pdf/i.test(entry.text || ""));
        if (!candidate) throw new Error("The supervised download page did not expose a safe PDF candidate.");
        const imported = await call("paper_download", { tabId, candidateId: candidate.id });
        if (!imported.documentId) throw new Error("The supervised public PDF download was not imported.");
      }
      else {
        await call("browser_observe", { tabId, maxCharacters: 1_000 });
        await call("browser_snapshot", { tabId, maxElements: 30, maxTextCharacters: 1_000 });
      }
    } catch (error) {
      if (["TAB_WAITING_USER", "TAB_VERIFYING", "USER_ACTION_REQUIRED"].includes(error?.name)) outcome = "human-boundary";
      else { outcome = "unavailable"; reason = safeFailureClass(error); }
    }
    const accepted = outcome === item.expect || (item.expect === "human-boundary" && outcome === "ready");
    results.push({ category: item.category, outcome, reason, accepted });
    console.error(`[public-acceptance] ${item.category}: ${outcome}`);
    await call("browser_tab_close", { tabId, force: true }).catch(() => undefined);
  }
  console.log(JSON.stringify({ supervised: true, isolatedProfile: true, consequentialActions: 0, credentialsUsed: 0, categories: results }, null, 2));
  if (results.some((item) => !item.accepted)) process.exitCode = 1;
} finally {
  await runtime.dispose();
}
