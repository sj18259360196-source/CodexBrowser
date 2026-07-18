# 2026-07-13 - Browser Actions

## Objective

Give Codex fast, observable interaction with human web pages by adding referenced page snapshots, safe element actions, and event-driven waits. Establish a mandatory Markdown work-log process and backfill the initial MVP record.

## Decisions

- Use DOM and accessibility-oriented element metadata before screenshots.
- Assign page-local `cb-e*` references to visible interactive elements.
- Block automated filling of passwords, one-time codes, hidden inputs, and file inputs.
- Log the action target but never log sensitive field values.
- Keep actions visible by scrolling and briefly highlighting the target element.
- Prefer condition-based waits over fixed sleep calls.

## Changes

- Added project-level `AGENTS.md` instructions requiring a Markdown work log for every implementation session.
- Added `WORKLOG.md` as the chronological index and backfilled the complete initial MVP record.
- Added versioned snapshot and action contracts in `src/shared/contracts.ts`.
- Added `src/electron/browser-actions.ts` with:
  - Visible interactive-element discovery and page-local `cb-e*` references.
  - Accessible names, roles, bounds, state, normal values, and sensitive-element flags.
  - Click, fill, select, focus, key press, and scroll actions.
  - Target scrolling and temporary visual highlighting so the user can see what Codex operates.
  - Native keyboard delivery with a deterministic DOM-event fallback when the browser window is in the background.
  - Direct scrolling-element control for reliable background and high-DPI scrolling.
  - Load, idle, URL, text, and selector waits using browser events or `MutationObserver` rather than repeated MCP polling.
- Blocked automation for passwords, verification codes, hidden inputs, file inputs, token-like fields, and controls inside sensitive authentication forms.
- Added browser task-history entries for snapshots, actions, waits, sensitive-action interruptions, and completed human takeover.
- Added `browser_snapshot`, `browser_act`, and `browser_wait` to the MCP server, increasing the tool count from 18 to 21.
- Updated the `browser-operator` and `paper-research` plugin skills to use snapshots, referenced actions, and condition-based waits.
- Updated the personal plugin cache version to `0.1.0+codex.20260713160354` and validated it.
- Added `interaction-test.html` and `browser-action-smoke.mjs` to exercise normal inputs, selects, buttons, dynamic results, keyboard input, scrolling, and sensitive password blocking.
- Updated the UI preview task list to show snapshots, normal field filling, element clicks, and authorization waits.
- Updated README tool documentation and the current MVP capability list.

## Verification

- `npm run typecheck`: passed.
- `npm run build`: passed for renderer, Electron, and MCP bundles.
- `npm audit --omit=dev`: zero production vulnerabilities.
- Plugin validator: passed.
- `npm run smoke:mcp`: discovered 21 tools and called `browser_status` successfully.
- `npm run smoke:actions`: passed after a clean desktop restart.
- The action smoke test verified:
  - Three referenced elements discovered on the interaction fixture.
  - Normal field fill and select actions.
  - Button click and dynamic text completion.
  - Event-driven text and selector waits.
  - Real or fallback keyboard event delivery.
  - Scroll delivery through the page scrolling element.
  - Password fields marked sensitive and blocked from automated filling.
- The action smoke test also passed twice consecutively after the input and scrolling reliability fixes.
- Playwright snapshot and screenshot passed at 1440x900 with no application console errors: `output/playwright/codex-browser-actions-1440x900.png`.
- The desktop was restarted after testing and left at a clean Crossref home state with no test tasks or documents.

## Known Issues

- The current shell still cannot execute the WindowsApps `codex.exe`; plugin reinstall through `codex plugin add codex-browser@personal` fails with access denied. The personal marketplace entry and validated source are updated.
- Element references are page-local and intentionally become stale after navigation or major DOM replacement. Codex must capture a new snapshot.
- The current snapshot implementation covers the main document only. Cross-origin iframes and closed shadow roots require a future driver extension.
- File uploads, credentials, MFA, captchas, and authentication-form submission remain manual by design.
- Only one browser profile and one visible tab are currently implemented.

## Next Steps

- Add institution profile management and session-health checks.
- Add the first real university off-campus login adapter and publisher adapters after receiving the target institution and databases.
- Add same-origin iframe and open-shadow-root snapshot traversal.
- Add multi-tab support and download-to-document task correlation.
