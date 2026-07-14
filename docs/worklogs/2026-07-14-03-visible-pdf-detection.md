# 2026-07-14 - Visible PDF Detection

## Objective

Allow the paper download workflow to save a PDF that is already visible in Chromium's built-in PDF reader when the reader exposes the source through an indirect or stale navigation representation.

## Decisions

- Keep the existing loaded-response capture and `printToPDF` fallback unchanged.
- Broaden only PDF detection, using current web contents, tab state, and active navigation state as independent evidence.
- Recognize direct `.pdf` paths and PDF URLs nested in query parameters without exposing signed query values.

## Changes

- Added `valueLooksLikePdf` to recognize direct, trailing-slash, query-embedded, and publisher route-based PDF URLs such as `/doi/pdf/`, `/pdfft`, and `/pdf`.
- Updated `tabLooksLikePdf` to inspect web contents, synchronized tab state, and active navigation state.
- Kept strict page-URL freshness for normal links while allowing local PDF candidates to survive Chromium's source-to-viewer URL transition when the same tab still displays a PDF.
- Updated the advanced smoke test to accept both captured `loaded_pdf` and Chromium-exported `visible_pdf` candidates, which share the same no-network-save contract.
- Reloaded the control fixture and refreshed its popup element reference after the PDF-tab workflow so later interaction checks start from a settled page.
- Sanitized `browser_wait` titles and details as well as URLs, preventing signed PDF query values embedded in viewer titles from reaching MCP output.

## Verification

- `npm run typecheck`: passed.
- `npm run build`: passed for renderer, Electron, and MCP bundles.
- `npm run smoke:mcp`: passed with 33 tools, protocol `1.2.0`, a healthy restored session, and no active authorization prompt.
- The advanced smoke reached and passed the local PDF candidate, no-network save, PDF signature, document import, and PDF-tab close assertions. Full-suite reruns later hit unrelated fixture flakiness in authentication-resolution text and post-PDF popup interaction.
- Live authorized verification saved visible PDFs from ScienceDirect, ACS `/doi/pdf/` routes, ACS SI routes, and JBC without re-requesting signed publisher URLs.
- The literature task produced 16 main PDFs and 12 SI files. All 23 PDFs parsed successfully; 4 DOCX files passed Office ZIP checks; the CIF passed structural checks; first pages of all 16 main PDFs were rendered and visually matched their DOI records.

## Known Issues

- Publisher authentication, captcha, and download restrictions remain unchanged and still require authorized user access.
- `Network.getResponseBody` is opportunistic for Chromium's PDF MIME handler; the tested `visible_pdf`/`printToPDF` fallback remains necessary.
- The complete `smoke:advanced` sequence is still intermittent outside the PDF assertions and needs separate fixture stabilization.

## Next Steps

- Add focused tests that force `visible_pdf`, cover publisher route detection, and verify navigation away from a PDF invalidates the local candidate.
- Stabilize the advanced authentication and popup fixtures independently of the PDF workflow.
