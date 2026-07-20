import { randomInt } from "node:crypto";
import { startIsolatedEdgeSmoke } from "./lib/isolated-edge-smoke.mjs";

const SAMPLE_SIZE = 10;
const papers = [
  { id: "1706.03762", title: "Attention Is All You Need", query: "transformer" },
  { id: "1810.04805", title: "BERT", query: "BERT" },
  { id: "2005.14165", title: "Language Models are Few-Shot Learners", query: "language model" },
  { id: "1512.03385", title: "Deep Residual Learning for Image Recognition", query: "residual" },
  { id: "1409.1556", title: "Very Deep Convolutional Networks", query: "convolutional" },
  { id: "1312.6114", title: "Auto-Encoding Variational Bayes", query: "variational" },
  { id: "1406.2661", title: "Generative Adversarial Nets", query: "generative" },
  { id: "1506.02640", title: "You Only Look Once", query: "detection" },
  { id: "1603.02754", title: "XGBoost", query: "XGBoost" },
  { id: "2103.00020", title: "Learning Transferable Visual Models", query: "contrastive" },
  { id: "2010.11929", title: "An Image is Worth 16x16 Words", query: "transformer" },
  { id: "2203.02155", title: "Training Language Models to Follow Instructions", query: "instruction" },
  { id: "2307.09288", title: "Llama 2", query: "Llama" },
  { id: "1910.10683", title: "Exploring the Limits of Transfer Learning", query: "transfer" },
  { id: "1907.11692", title: "RoBERTa", query: "RoBERTa" },
];

function randomSample(values, size) {
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const other = randomInt(index + 1);
    [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
  }
  return shuffled.slice(0, size);
}

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

function safeFailure(error) {
  return {
    code: String(error?.name || "ERROR").replace(/[^A-Z0-9_]/gi, "_").slice(0, 48),
    message: String(error?.message || error).replace(/https?:\/\/\S+/gi, "[url]").slice(0, 300),
  };
}

const selected = randomSample(papers, SAMPLE_SIZE);
const runtime = await startIsolatedEdgeSmoke({
  suiteName: "literature-batch",
  clientName: "literature-batch-smoke",
});
const call = async (name, args = {}) => parse(await runtime.client.callTool({ name, arguments: args }));
const results = [];

try {
  const tabId = (await call("browser_tabs")).activeTabId;
  for (const [index, paper] of selected.entries()) {
    const startedAt = Date.now();
    console.error(`[literature-batch] ${index + 1}/${selected.length} ${paper.id}: start`);
    try {
      const navigation = await call("browser_navigate", { tabId, url: `https://arxiv.org/abs/${paper.id}` });
      if (navigation.assistance) throw new Error(`Unexpected ${navigation.assistance.kind} assistance boundary.`);
      await call("browser_wait", { tabId, condition: "idle", timeoutMs: 15_000 });

      const candidates = await call("paper_find_downloads", { tabId });
      const candidate = candidates.find((entry) => /pdf/i.test(String(entry.text || "")));
      if (!candidate) throw new Error("No PDF candidate was found on the abstract page.");
      if (/token=|signature=|expires=/i.test(JSON.stringify(candidate))) throw new Error("Candidate metadata exposed transient authorization data.");

      const downloaded = await call("paper_download", { tabId, candidateId: candidate.id });
      if (!downloaded.documentId) throw new Error("The PDF was not imported into the document library.");
      const firstPage = await call("document_read", { documentId: downloaded.documentId, startPage: 1, endPage: 1 });
      const pageText = String(firstPage.pages?.[0]?.text || "");
      if (pageText.length < 500) throw new Error(`First-page extraction was unexpectedly short (${pageText.length} characters).`);
      const hits = await call("document_search", { documentId: downloaded.documentId, query: paper.query, limit: 10 });
      if (!Array.isArray(hits) || !hits.length) throw new Error(`Extracted text did not contain the expected query: ${paper.query}.`);

      results.push({
        id: paper.id,
        title: paper.title,
        ok: true,
        pages: firstPage.document.pages,
        firstPageCharacters: pageText.length,
        searchHits: hits.length,
        elapsedMs: Date.now() - startedAt,
      });
      console.error(`[literature-batch] ${index + 1}/${selected.length} ${paper.id}: passed`);
    } catch (error) {
      results.push({ id: paper.id, title: paper.title, ok: false, ...safeFailure(error), elapsedMs: Date.now() - startedAt });
      console.error(`[literature-batch] ${index + 1}/${selected.length} ${paper.id}: failed`);
      await call("browser_stop").catch(() => undefined);
    }
  }

  const passed = results.filter((result) => result.ok).length;
  console.log(JSON.stringify({
    sampleSize: selected.length,
    passed,
    failed: selected.length - passed,
    credentialsUsed: 0,
    isolatedProfile: true,
    results,
  }, null, 2));
  if (passed !== selected.length) process.exitCode = 1;
} finally {
  await runtime.dispose();
}
