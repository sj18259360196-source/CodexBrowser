import assert from "node:assert/strict";
import test from "node:test";
import { isCapturablePdfResponse } from "../src/browser/pdf-response.ts";

test("captures only successful responses explicitly identified as PDFs", () => {
  assert.equal(isCapturablePdfResponse(200, [{ name: "Content-Type", value: "application/pdf" }]), true);
  assert.equal(isCapturablePdfResponse(206, [{ name: "content-type", value: "application/pdf; charset=binary" }]), true);
  assert.equal(isCapturablePdfResponse(200, [
    { name: "content-type", value: "application/octet-stream" },
    { name: "content-disposition", value: 'attachment; filename="paper.pdf"' },
  ]), true);
});

test("passes HTML challenges, redirects, and error pages through untouched", () => {
  assert.equal(isCapturablePdfResponse(403, [{ name: "content-type", value: "text/html" }]), false);
  assert.equal(isCapturablePdfResponse(503, [{ name: "content-type", value: "text/html; charset=UTF-8" }]), false);
  assert.equal(isCapturablePdfResponse(302, [{ name: "location", value: "https://example.test/login" }]), false);
  assert.equal(isCapturablePdfResponse(200, [{ name: "content-type", value: "text/html" }]), false);
  assert.equal(isCapturablePdfResponse(200, [{ name: "content-type", value: "application/octet-stream" }]), false);
});
