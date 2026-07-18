import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { inflateSync } from "node:zlib";
import {
  projectRoot,
  sleep,
  startIsolatedElectronSmoke,
} from "./lib/isolated-electron-smoke.mjs";

const fixtureRoot = path.join(projectRoot, "tests", "fixtures");
const sensitiveMarkers = [
  "Vega-41Qx!",
  "Orion-82Lm!",
  "Lyra-73Np!",
  "Draco-64Rt!",
  "Altair-55Hs!",
  "Deneb-46Jv!",
  "Solis-37Kw!",
  "Cygnus-28Mx!",
  "Polaris-19Bz!",
  "Aquila-91Cd!",
  "Phoenix-84Ef!",
  "Hydra-75Gh!",
  "Mercury-62Lq!",
  "Saturn-53Pw!",
  "Jupiter-44Ns!",
  "Neptune-43Qr!",
  "Titan-42Uv!",
];

function assertNoSensitiveMarkers(label, value) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (sensitiveMarkers.some((marker) => serialized.includes(marker))) {
    throw new Error(`${label} exposed a synthetic sensitive-field marker.`);
  }
}

function inspectTextBlocks(label, result) {
  for (const block of result.content || []) {
    if (block.type === "text" && typeof block.text === "string") {
      assertNoSensitiveMarkers(label, block.text);
    }
  }
  return result;
}

function parseTextResult(label, result) {
  inspectTextBlocks(label, result);
  const block = result.content?.find((item) => item.type === "text");
  if (!block || typeof block.text !== "string") throw new Error(`${label} returned no MCP text block.`);
  return JSON.parse(block.text);
}

async function callResult(client, name, arguments_) {
  return inspectTextBlocks(name, await client.callTool({ name, arguments: arguments_ || {} }));
}

async function callOk(client, name, arguments_) {
  const result = await callResult(client, name, arguments_);
  if (result.isError) {
    const error = parseTextResult(`${name} error`, result);
    throw new Error(`${name} returned ${error.error || "BROWSER_ERROR"}: ${error.message || "sanitized error"}`);
  }
  return result;
}

function requireElement(snapshot, predicate, label) {
  const element = snapshot.elements?.find(predicate);
  if (!element) throw new Error(`Sensitive snapshot did not contain ${label}.`);
  return element;
}

function tabId(result) {
  return result.createdTabId || result.activeTabId || result.tabId || result.id;
}

async function waitForTabState(client, targetTabId, expectedState) {
  let lastState = "missing";
  let lastRuntime = "unknown";
  let lastAuthReason = "none";
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const statusResult = await callOk(client, "browser_status");
    const status = parseTextResult("browser_status", statusResult);
    const tab = status.tabs?.find((candidate) => candidate.id === targetTabId);
    lastState = tab?.state || "missing";
    lastRuntime = status.runtimeStatus || "unknown";
    lastAuthReason = status.authPrompt?.reason || "none";
    if (tab?.state === expectedState) return status;
    await sleep(100);
  }
  throw new Error(`Tab did not enter ${expectedState} during the sensitive-field smoke (tab=${lastState}, runtime=${lastRuntime}, auth=${lastAuthReason}).`);
}

function paethPredictor(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const diagonalDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= diagonalDistance) return left;
  return upDistance <= diagonalDistance ? up : upLeft;
}

function decodePng(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buffer.subarray(0, 8).equals(signature)) throw new Error("Screenshot was not a PNG image.");
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) throw new Error("Screenshot PNG chunk was truncated.");
    if (type === "IHDR") {
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      bitDepth = buffer[dataStart + 8];
      colorType = buffer[dataStart + 9];
      interlace = buffer[dataStart + 12];
    } else if (type === "IDAT") {
      idat.push(buffer.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!width || !height || bitDepth !== 8 || !channels || interlace !== 0) {
    throw new Error("Screenshot PNG used an unsupported pixel format.");
  }
  const compressed = Buffer.concat(idat);
  const filtered = inflateSync(compressed);
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  let sourceOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = filtered[sourceOffset];
    sourceOffset += 1;
    const rowOffset = y * stride;
    const priorOffset = rowOffset - stride;
    for (let x = 0; x < stride; x += 1) {
      const raw = filtered[sourceOffset + x];
      const left = x >= channels ? pixels[rowOffset + x - channels] : 0;
      const up = y > 0 ? pixels[priorOffset + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[priorOffset + x - channels] : 0;
      let value;
      if (filter === 0) value = raw;
      else if (filter === 1) value = raw + left;
      else if (filter === 2) value = raw + up;
      else if (filter === 3) value = raw + Math.floor((left + up) / 2);
      else if (filter === 4) value = raw + paethPredictor(left, up, upLeft);
      else throw new Error("Screenshot PNG used an unknown row filter.");
      pixels[rowOffset + x] = value & 0xff;
    }
    sourceOffset += stride;
  }
  return { width, height, channels, colorType, pixels };
}

function pixelAt(image, x, y) {
  const safeX = Math.max(0, Math.min(image.width - 1, Math.floor(x)));
  const safeY = Math.max(0, Math.min(image.height - 1, Math.floor(y)));
  const offset = (safeY * image.width + safeX) * image.channels;
  if (image.colorType === 6) {
    return [image.pixels[offset], image.pixels[offset + 1], image.pixels[offset + 2], image.pixels[offset + 3]];
  }
  if (image.colorType === 2) {
    return [image.pixels[offset], image.pixels[offset + 1], image.pixels[offset + 2], 255];
  }
  if (image.colorType === 4) {
    return [image.pixels[offset], image.pixels[offset], image.pixels[offset], image.pixels[offset + 1]];
  }
  return [image.pixels[offset], image.pixels[offset], image.pixels[offset], 255];
}

function isRedactionPixel(pixel) {
  return Math.abs(pixel[0] - 32) <= 4
    && Math.abs(pixel[1] - 36) <= 4
    && Math.abs(pixel[2] - 33) <= 4
    && pixel[3] >= 245;
}

function screenshotPayload(label, result) {
  const metadata = parseTextResult(label, result);
  const imageBlock = result.content?.find((item) => item.type === "image");
  if (!imageBlock || typeof imageBlock.data !== "string" || imageBlock.mimeType !== "image/png") {
    throw new Error(`${label} returned no PNG image block.`);
  }
  const encoded = imageBlock.data.includes(",")
    ? imageBlock.data.slice(imageBlock.data.indexOf(",") + 1)
    : imageBlock.data;
  const image = decodePng(Buffer.from(encoded, "base64"));
  if (metadata.width !== image.width || metadata.height !== image.height) {
    throw new Error(`${label} metadata did not match the PNG dimensions.`);
  }
  return { metadata, image };
}

function scaleForSnapshot(snapshot, image) {
  const probe = requireElement(snapshot, (element) => element.name === "Viewport scale probe", "the viewport scale probe");
  if (probe.rect.width <= 0) throw new Error("Viewport scale probe had no width.");
  return image.width / probe.rect.width;
}

function redactionPixelCount(image, rect, scale) {
  const left = Math.max(0, Math.floor(rect.x * scale));
  const top = Math.max(0, Math.floor(rect.y * scale));
  const right = Math.min(image.width, Math.ceil((rect.x + rect.width) * scale));
  const bottom = Math.min(image.height, Math.ceil((rect.y + rect.height) * scale));
  let count = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      if (isRedactionPixel(pixelAt(image, x, y))) count += 1;
    }
  }
  return count;
}

function assertRectRedacted(label, image, rect, scale, minimumPixels = 20) {
  if (redactionPixelCount(image, rect, scale) < minimumPixels) {
    throw new Error(`${label} was not visibly covered by the screenshot redaction color.`);
  }
}

function assertElementScreenshotRedacted(image) {
  const center = pixelAt(image, image.width / 2, image.height / 2);
  if (!isRedactionPixel(center)) throw new Error("Sensitive element screenshot center was not redacted.");
}

async function readRequiredSanitizedFile(filePath, label) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const contents = await readFile(filePath, "utf8");
      assertNoSensitiveMarkers(label, contents);
      return contents;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await sleep(100);
    }
  }
  throw new Error(`${label} was not written inside the isolated smoke profile.`);
}

let fixtureOrigin = "";
const fixture = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
    if (pathname === "/sensitive-download.bin") {
      const bytes = Buffer.from("synthetic download payload", "utf8");
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": 'attachment; filename="Hydra-75Gh!.bin"',
        "Cache-Control": "no-store",
        "Content-Length": bytes.length,
      });
      response.end(bytes);
      return;
    }
    const fixtures = new Map([
      ["/sensitive-fields.html", "sensitive-fields.html"],
      ["/sensitive-frame.html", "sensitive-frame.html"],
      ["/cross-origin-sensitive-frame.html", "cross-origin-sensitive-frame.html"],
      ["/sensitive-metadata.html", "sensitive-metadata.html"],
      ["/dynamic-sensitive.html", "dynamic-sensitive.html"],
    ]);
    const fileName = fixtures.get(pathname);
    if (!fileName) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    let body = await readFile(path.join(fixtureRoot, fileName), "utf8");
    if (fileName === "sensitive-fields.html") {
      const crossOriginUrl = fixtureOrigin.replace("127.0.0.1", "localhost") + "/cross-origin-sensitive-frame.html";
      body = body.replace("__CROSS_ORIGIN_URL__", crossOriginUrl);
    }
    const bytes = Buffer.from(body, "utf8");
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": bytes.length,
    });
    response.end(bytes);
  } catch {
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Fixture error");
  }
});

await new Promise((resolve, reject) => {
  fixture.once("error", reject);
  fixture.listen(0, "127.0.0.1", resolve);
});
const address = fixture.address();
if (!address || typeof address === "string") throw new Error("Sensitive fixture did not expose a TCP port.");
fixtureOrigin = `http://127.0.0.1:${address.port}`;

let runtime;

try {
  runtime = await startIsolatedElectronSmoke({
    suiteName: "sensitive-field-smoke",
    clientName: "codex-browser-sensitive-smoke",
  });
  const { client, profileDir } = runtime;

  const staticTab = parseTextResult("browser_tab_new", await callOk(client, "browser_tab_new", {
    url: `${fixtureOrigin}/sensitive-fields.html`,
    activate: true,
  }));
  const staticTabId = tabId(staticTab);
  if (!staticTabId) throw new Error("Sensitive fixture tab had no tab ID.");
  parseTextResult("browser_wait", await callOk(client, "browser_wait", {
    tabId: staticTabId,
    condition: "text",
    value: "Sensitive field fixture ready",
    timeoutMs: 5_000,
  }));
  const staticSnapshot = parseTextResult("browser_snapshot", await callOk(client, "browser_snapshot", {
    tabId: staticTabId,
    maxElements: 100,
  }));
  assertNoSensitiveMarkers("static snapshot", staticSnapshot);
  const staticStatus = await waitForTabState(client, staticTabId, "WAITING_USER");
  assertNoSensitiveMarkers("static browser status", staticStatus);
  const sensitiveElements = staticSnapshot.elements.filter((element) => element.sensitive);
  if (sensitiveElements.length < 12) throw new Error("Sensitive snapshot classified too few protected controls.");
  if (sensitiveElements.some((element) => !["Sensitive input", "Sensitive action"].includes(element.name))) {
    throw new Error("A sensitive element did not use a fixed safe name.");
  }
  if (sensitiveElements.some((element) => element.value !== undefined || element.placeholder !== undefined || element.text)) {
    throw new Error("A sensitive element retained value, placeholder, or text metadata.");
  }
  if (staticSnapshot.elements.some((element) => !/^cb-e\d+$/.test(element.ref))) {
    throw new Error("A snapshot element used a page-controlled reference.");
  }
  if (new Set(staticSnapshot.elements.map((element) => element.ref)).size !== staticSnapshot.elements.length) {
    throw new Error("Snapshot element references were not unique.");
  }
  if (sensitiveElements.filter((element) => element.type === "password").length < 3) {
    throw new Error("Password, autofill, or iframe password fields were not all protected.");
  }
  if (sensitiveElements.filter((element) => element.type === "text").length < 6) {
    throw new Error("Autocomplete, OTP, CAPTCHA, or token-like text fields were not all protected.");
  }
  const password = requireElement(staticSnapshot, (element) => element.sensitive && element.type === "password", "an unlabeled password field");
  const otp = requireElement(staticSnapshot, (element) => element.sensitive && element.type === "text", "a sensitive text field");
  const fileField = requireElement(staticSnapshot, (element) => element.sensitive && element.type === "file", "the file field");
  const submit = requireElement(staticSnapshot, (element) => element.sensitive && element.role === "button", "the login submit button");
  const canvas = requireElement(staticSnapshot, (element) => element.sensitive && element.tag === "canvas", "the CAPTCHA canvas");
  const crossOriginFrame = requireElement(staticSnapshot, (element) => element.name === "External content frame", "the cross-origin frame");
  if (!fileField.sensitive || !submit.sensitive || !canvas.sensitive) throw new Error("A required sensitive control was not protected.");

  const observation = parseTextResult("browser_observe", await callOk(client, "browser_observe", {
    tabId: staticTabId,
    maxCharacters: 20_000,
  }));
  assertNoSensitiveMarkers("static observation", observation);
  if (!observation.authRequired || !observation.forms.some((form) => form.hasPassword)) {
    throw new Error("Sensitive observation did not retain its sanitized authentication signal.");
  }

  const viewportScreenshotResult = await callOk(client, "browser_screenshot", {
    tabId: staticTabId,
    maxWidth: 2_048,
    redactSensitive: false,
  });
  const viewportScreenshot = screenshotPayload("browser_screenshot viewport", viewportScreenshotResult);
  if (viewportScreenshot.metadata.redactionCount < sensitiveElements.length) {
    throw new Error("Viewport screenshot reported too few redaction regions.");
  }
  const staticScale = scaleForSnapshot(staticSnapshot, viewportScreenshot.image);
  assertRectRedacted("Password field", viewportScreenshot.image, password.rect, staticScale);
  assertRectRedacted("OTP field", viewportScreenshot.image, otp.rect, staticScale);
  assertRectRedacted("Login submit", viewportScreenshot.image, submit.rect, staticScale);
  assertRectRedacted("CAPTCHA canvas", viewportScreenshot.image, canvas.rect, staticScale);
  assertRectRedacted("Cross-origin iframe", viewportScreenshot.image, crossOriginFrame.rect, staticScale);
  const mirror = requireElement(staticSnapshot, (element) => element.name === "Mirrored sensitive values", "the sensitive mirror");
  assertRectRedacted("Mirrored sensitive text", viewportScreenshot.image, mirror.rect, staticScale);

  const elementScreenshotResult = await callOk(client, "browser_screenshot", {
    tabId: staticTabId,
    scope: "element",
    ref: password.ref,
    revision: staticSnapshot.revision,
    maxWidth: 2_048,
    redactSensitive: false,
  });
  const elementScreenshot = screenshotPayload("browser_screenshot element", elementScreenshotResult);
  assertElementScreenshotRedacted(elementScreenshot.image);

  const waitingMutation = await callResult(client, "browser_act", {
    tabId: staticTabId,
    action: "fill",
    ref: password.ref,
    revision: staticSnapshot.revision,
    text: "Jupiter-44Ns!",
  });
  if (!waitingMutation.isError) throw new Error("WAITING_USER allowed a sensitive field mutation.");

  const metadataTab = parseTextResult("browser_tab_new", await callOk(client, "browser_tab_new", {
    url: `${fixtureOrigin}/sensitive-metadata.html`,
    activate: true,
  }));
  const metadataTabId = tabId(metadataTab);
  if (!metadataTabId) throw new Error("Metadata fixture tab had no tab ID.");
  const metadataWait = parseTextResult("metadata browser_wait", await callOk(client, "browser_wait", {
    tabId: metadataTabId,
    condition: "text",
    value: "Metadata fixture ready",
    timeoutMs: 5_000,
  }));
  assertNoSensitiveMarkers("metadata wait result", metadataWait);
  const metadataSnapshot = parseTextResult("metadata browser_snapshot", await callOk(client, "browser_snapshot", {
    tabId: metadataTabId,
  }));
  const safeAction = requireElement(metadataSnapshot, (element) => element.name === "Run safe action", "the safe metadata action");
  const metadataMirror = requireElement(metadataSnapshot, (element) => element.name === "Mirrored page text", "the metadata mirror");
  assertNoSensitiveMarkers("metadata snapshot", metadataSnapshot);
  const metadataObservation = parseTextResult("metadata browser_observe", await callOk(client, "browser_observe", {
    tabId: metadataTabId,
  }));
  assertNoSensitiveMarkers("metadata observation", metadataObservation);
  const safeActionResult = parseTextResult("metadata browser_act", await callOk(client, "browser_act", {
    tabId: metadataTabId,
    action: "click",
    ref: safeAction.ref,
    revision: metadataSnapshot.revision,
  }));
  assertNoSensitiveMarkers("metadata action result", safeActionResult);
  const metadataCompleted = parseTextResult("metadata completion wait", await callOk(client, "browser_wait", {
    tabId: metadataTabId,
    condition: "text",
    value: "Safe action completed",
    timeoutMs: 3_000,
  }));
  assertNoSensitiveMarkers("metadata completion result", metadataCompleted);
  const metadataScreenshotResult = await callOk(client, "browser_screenshot", {
    tabId: metadataTabId,
    maxWidth: 2_048,
    redactSensitive: false,
  });
  const metadataScreenshot = screenshotPayload("metadata screenshot", metadataScreenshotResult);
  if (metadataScreenshot.metadata.redactionCount < 1) throw new Error("Metadata screenshot did not report text redaction.");
  const metadataScale = scaleForSnapshot(metadataSnapshot, metadataScreenshot.image);
  assertRectRedacted("Metadata text mirror", metadataScreenshot.image, metadataMirror.rect, metadataScale, 5);
  const metadataStatus = parseTextResult("metadata browser_status", await callOk(client, "browser_status"));
  assertNoSensitiveMarkers("metadata browser status", metadataStatus);
  const forgedRefResult = await callResult(client, "browser_act", {
    tabId: metadataTabId,
    action: "click",
    ref: "Neptune-43Qr!",
    revision: metadataSnapshot.revision,
  });
  if (!forgedRefResult.isError) throw new Error("A forged page reference unexpectedly completed.");
  parseTextResult("forged ref error", forgedRefResult);
  const forgedRefStatus = parseTextResult("forged ref browser_status", await callOk(client, "browser_status"));
  assertNoSensitiveMarkers("forged ref browser status", forgedRefStatus);

  const sensitiveDownloadJob = parseTextResult("sensitive paper_download", await callOk(client, "paper_download", {
    tabId: metadataTabId,
    url: `${fixtureOrigin}/sensitive-download.bin?token=Mercury-62Lq!`,
  }));
  let sensitiveDownload;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const downloads = parseTextResult("sensitive downloads_list", await callOk(client, "downloads_list"));
    sensitiveDownload = downloads.find((download) => download.id === sensitiveDownloadJob.jobId);
    if (sensitiveDownload && !["starting", "progressing"].includes(sensitiveDownload.state)) break;
    await sleep(100);
  }
  if (!sensitiveDownload) throw new Error("Sensitive filename download did not create a download record.");
  if (!/^download-\d{13}-[a-f0-9]{8}\.bin$/i.test(sensitiveDownload.fileName || "")) {
    throw new Error("Sensitive filename download did not use a generated safe name.");
  }
  const postDownloadStatus = parseTextResult("post-download browser_status", await callOk(client, "browser_status"));
  assertNoSensitiveMarkers("post-download browser status", postDownloadStatus);

  const dynamicTab = parseTextResult("browser_tab_new", await callOk(client, "browser_tab_new", {
    url: `${fixtureOrigin}/dynamic-sensitive.html`,
    activate: true,
  }));
  const dynamicTabId = tabId(dynamicTab);
  if (!dynamicTabId) throw new Error("Dynamic fixture tab had no tab ID.");
  parseTextResult("dynamic browser_wait", await callOk(client, "browser_wait", {
    tabId: dynamicTabId,
    condition: "text",
    value: "Dynamic field ready",
    timeoutMs: 5_000,
  }));
  const initialDynamicSnapshot = parseTextResult("dynamic initial snapshot", await callOk(client, "browser_snapshot", {
    tabId: dynamicTabId,
  }));
  const initialDynamic = requireElement(initialDynamicSnapshot, (element) => element.name === "Transient text field", "the initial dynamic field");
  if (initialDynamic.sensitive || initialDynamic.type !== "text") throw new Error("Dynamic field was not initially ordinary text.");

  await sleep(2_900);
  const passwordDynamicSnapshot = parseTextResult("dynamic password snapshot", await callOk(client, "browser_snapshot", {
    tabId: dynamicTabId,
  }));
  const passwordDynamic = requireElement(passwordDynamicSnapshot, (element) => element.tag === "input", "the password-phase dynamic field");
  if (!passwordDynamic.sensitive || passwordDynamic.type !== "password" || passwordDynamic.value !== undefined) {
    throw new Error("Dynamic text-to-password conversion was not protected.");
  }
  assertNoSensitiveMarkers("dynamic password snapshot", passwordDynamicSnapshot);

  await sleep(3_000);
  const revealedDynamicSnapshot = parseTextResult("dynamic revealed snapshot", await callOk(client, "browser_snapshot", {
    tabId: dynamicTabId,
  }));
  const revealedDynamic = requireElement(revealedDynamicSnapshot, (element) => element.tag === "input", "the revealed dynamic field");
  if (!revealedDynamic.sensitive || revealedDynamic.type !== "text" || revealedDynamic.value !== undefined) {
    throw new Error("A previously sensitive field became readable after a reveal toggle.");
  }
  assertNoSensitiveMarkers("dynamic revealed snapshot", revealedDynamicSnapshot);

  const dynamicBlocked = await callResult(client, "browser_act", {
    tabId: dynamicTabId,
    action: "fill",
    ref: revealedDynamic.ref,
    revision: revealedDynamicSnapshot.revision,
    text: "Jupiter-44Ns!",
  });
  if (!dynamicBlocked.isError) throw new Error("A dynamically protected field accepted an automated fill.");
  const dynamicError = parseTextResult("dynamic blocked error", dynamicBlocked);
  if (dynamicError.error !== "USER_ACTION_REQUIRED") {
    throw new Error("Dynamic sensitive action did not return USER_ACTION_REQUIRED.");
  }
  const dynamicObservation = parseTextResult("dynamic browser_observe", await callOk(client, "browser_observe", {
    tabId: dynamicTabId,
  }));
  assertNoSensitiveMarkers("dynamic observation", dynamicObservation);
  const dynamicScreenshot = screenshotPayload("dynamic browser_screenshot", await callOk(client, "browser_screenshot", {
    tabId: dynamicTabId,
    maxWidth: 2_048,
    redactSensitive: false,
  }));
  assertNoSensitiveMarkers("dynamic screenshot metadata", dynamicScreenshot.metadata);
  assertElementScreenshotRedacted(dynamicScreenshot.image);
  const dynamicStatus = parseTextResult("dynamic browser_status", await callOk(client, "browser_status"));
  assertNoSensitiveMarkers("dynamic browser status", dynamicStatus);
  const assistanceStatus = parseTextResult("browser_assistance_status", await callOk(client, "browser_assistance_status"));
  assertNoSensitiveMarkers("assistance status", assistanceStatus);
  const pendingAssistanceId = assistanceStatus.assistanceId || assistanceStatus.id;
  if (!pendingAssistanceId) throw new Error("Dynamic sensitive action created no assistance request.");
  const completedAssistance = parseTextResult("browser_assistance_complete", await callOk(client, "browser_assistance_complete", {
    assistanceId: pendingAssistanceId,
    outcome: "unable",
    note: "Titan-42Uv!",
    userConfirmed: true,
  }));
  assertNoSensitiveMarkers("completed assistance", completedAssistance);
  const finalStatus = parseTextResult("final browser_status", await callOk(client, "browser_status"));
  assertNoSensitiveMarkers("final browser status", finalStatus);

  await sleep(800);
  await readRequiredSanitizedFile(path.join(profileDir, "state", "runtime-state.json"), "isolated runtime state");
  await readRequiredSanitizedFile(path.join(profileDir, "logs", "main.log"), "isolated runtime log");

  console.log(JSON.stringify({
    staticSensitiveElements: sensitiveElements.length,
    fixedSensitiveNames: true,
    pageControlledRefsRejected: true,
    iframeSensitiveFieldsRedacted: true,
    autofilledValueRedacted: true,
    dynamicClassificationMonotonic: true,
    waitingUserMutationBlocked: true,
    forgedReferenceSanitized: true,
    generatedDownloadNameSanitized: true,
    assistanceNoteDiscarded: true,
    viewportScreenshotRedactions: viewportScreenshot.metadata.redactionCount,
    sensitiveElementScreenshotMasked: true,
    mirroredTextScreenshotMasked: true,
    isolatedStateAndLogsSanitized: true,
  }, null, 2));
} finally {
  let disposeError;
  try {
    await runtime?.dispose();
  } catch (error) {
    disposeError = error;
  }
  await new Promise((resolve) => fixture.close(resolve));
  if (disposeError) throw disposeError;
}
