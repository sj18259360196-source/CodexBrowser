import { startIsolatedEdgeSmoke } from "./lib/isolated-edge-smoke.mjs";

const ARTICLE_URL = "https://arxiv.org/abs/1706.03762";

function parse(result) {
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("MCP returned no text payload.");
  const value = JSON.parse(text);
  if (result.isError) {
    const error = new Error(value.message || "MCP command failed.");
    error.name = value.error;
    throw error;
  }
  return value;
}

const runtime = await startIsolatedEdgeSmoke({
  suiteName: "literature-download",
  clientName: "literature-download-smoke",
});
const call = async (name, args = {}) => parse(await runtime.client.callTool({ name, arguments: args }));

try {
  const tabId = (await call("browser_tabs")).activeTabId;
  const navigation = await call("browser_navigate", { tabId, url: ARTICLE_URL });
  if (navigation.assistance) throw new Error(`The public arXiv abstract unexpectedly required ${navigation.assistance.kind}.`);
  await call("browser_wait", { tabId, condition: "idle", timeoutMs: 15_000 });

  const candidates = await call("paper_find_downloads", { tabId });
  const candidate = candidates.find((entry) => /pdf/i.test(String(entry.text || "")));
  if (!candidate) throw new Error("The arXiv abstract did not expose a PDF download candidate.");
  if (/token=|signature=|expires=/i.test(JSON.stringify(candidate))) {
    throw new Error("The literature candidate exposed transient authorization parameters.");
  }

  const downloaded = await call("paper_download", { tabId, candidateId: candidate.id });
  if (!downloaded.documentId) throw new Error("The arXiv PDF downloaded but was not imported into the document library.");

  const firstPage = await call("document_read", { documentId: downloaded.documentId, startPage: 1, endPage: 1 });
  const pageText = String(firstPage.pages?.[0]?.text || "");
  if (!/attention is all you need/i.test(pageText) || pageText.length < 1_000) {
    throw new Error("The imported arXiv PDF did not yield the expected first-page text.");
  }

  const hits = await call("document_search", { documentId: downloaded.documentId, query: "transformer", limit: 10 });
  if (!Array.isArray(hits) || !hits.length) throw new Error("The imported arXiv PDF was not searchable.");

  console.log(JSON.stringify({
    source: "arXiv",
    article: "Attention Is All You Need",
    candidateDetected: true,
    pdfDownloaded: true,
    documentImported: true,
    firstPageCharacters: pageText.length,
    searchHits: hits.length,
    credentialsUsed: 0,
  }, null, 2));
} finally {
  await runtime.dispose();
}
