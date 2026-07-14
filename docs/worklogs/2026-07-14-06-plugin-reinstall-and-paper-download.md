# Plugin reinstall and paper download

## Objective

Restore the Codex Browser plugin tools in Codex, launch the visible desktop, and use the authenticated browser session to download the requested ACS Nano article and supporting information.

## Decisions

- Keep the existing personal marketplace and plugin source instead of rewriting marketplace metadata.
- Use the plugin-creator cachebuster and reinstall workflow so Codex creates a fresh populated plugin cache.
- Use the visible Chromium PDF export path because direct non-browser requests to ACS returned HTTP 403.
- Preserve the browser library copies and place stable, descriptive final filenames under the research directory.

## Changes

- Started the Electron desktop from `A:\Project\CodexBrowser`.
- Updated the personal plugin cachebuster from `0.1.0+codex.20260714035331` to `0.1.0+codex.20260714073911` and reinstalled `codex-browser@personal`.
- Rebuilt the renderer, Electron process, and MCP server bundles.
- Downloaded the 14-page article and 28-page supporting information through the persistent ACS browser session.
- Copied the verified PDFs to `D:\科研\Defect-Rich Cu2O Nanospheres` with stable filenames.

## Verification

- Personal plugin validation passed.
- `npm run build` passed.
- `npm run smoke:mcp` passed, enumerating 33 tools and reporting the browser session.
- Both final files begin with the `%PDF-` signature and were parsed successfully with `pypdf`.
- Rendered page 1 of both PDFs with Poppler and visually confirmed readable text, figures, and page layout.
- `npm run typecheck` was run but failed on two pre-existing renderer fixture objects that are missing the required `credentialVault` property.

## Known issues

- `src/renderer/main.tsx` has two `AppState` fixture objects without `credentialVault`, so the standalone TypeScript check currently fails even though the production build and MCP smoke pass.
- Plugin tools are loaded when a Codex task starts; the refreshed tools require a new task to appear in the task tool list.

## Next steps

- Start a new Codex task when using `@codex-browser` so the refreshed MCP tools are loaded automatically.
- Repair the two renderer fixture objects in a separate implementation session if a clean `npm run typecheck` is required.
