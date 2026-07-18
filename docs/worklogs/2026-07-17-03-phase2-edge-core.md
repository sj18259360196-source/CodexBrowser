# 2026-07-17 - Phase 2 Edge Core Browsing

## Objective

Implement the minimum complete external Edge browsing loop behind `CODEX_BROWSER_RUNTIME=edge-prototype`, preserve Electron as the default runtime, verify all work with isolated local fixtures, and stop before Phase 3.

## Decisions

- Keep MCP browser commands behind the shared `BrowserAdapter` and a private named-pipe Edge broker; do not expose raw CDP, arbitrary evaluation, target/session IDs, debugging endpoints, cookies, authorization headers, or local paths.
- Retain the Phase 1 ephemeral loopback WebSocket CDP transport discovered through `DevToolsActivePort`.
- Use isolated worlds for bounded snapshot/element operations and trusted CDP input domains for user-like pointer and keyboard actions.
- Bind element refs to a tab, frame, and snapshot revision. Navigation, frame replacement, target loss, and reconnect invalidate old refs.
- Capture visible PDF bytes during the viewer navigation response and validate `%PDF-` before importing through the existing `DocumentService`.
- Treat the local Edge 150 loopback body behavior as a compatibility exception: only path-validated `127.0.0.1`/`localhost` smoke fixtures may use the cancellable Node stream fallback when Edge returns an empty synthetic response. Real non-loopback resources remain Edge-context-only and fail closed if CDP cannot provide a body.
- Give the isolated smoke helper an explicit unique profile path and a Windows failure fallback that terminates only `msedge.exe` processes whose command lines contain that exact managed profile path.

## Changes

- Added `EdgeBrowserAdapter` coverage for status, tabs, popup opener tracking, navigation/history/reload/stop, observations, snapshots, actions, waits, screenshots, dialogs, downloads, and visible PDF state.
- Added main-frame plus one-level same-origin/cross-origin iframe capture with viewport coordinate translation and partial frame failure handling.
- Added sensitive field classification, value suppression, screenshot masks, stale revision errors, obstruction checks, and `USER_ACTION_REQUIRED` blocks for passwords, OTP/token fields, file inputs, sensitive submits, and sensitive prompts.
- Added the Edge broker command router for the required browser, paper, download, and document MCP methods, including task generation checks and pause/resume/stop behavior.
- Added event-capable CDP transport request correlation and reconnect invalidation.
- Added managed download candidates, signed-query redaction, progress/cancellation records, PDF signature validation, and document import/read/search integration.
- Added `scripts/edge-core-smoke.mjs`, the shared isolated Edge smoke helper, the `smoke:edge-core` script, and expanded MCP wait contracts.
- Updated README, plan progress, package build entries, and Phase 1 smoke compatibility.

## Verification

- Compatible browser: Microsoft Edge 150.0.4078.65 on Windows.
- CDP transport: ephemeral `127.0.0.1` WebSocket discovered through the managed profile's `DevToolsActivePort` file.
- `npm run typecheck`: passed.
- `npm run build`: passed for renderer, Electron, Edge broker/runtime, and MCP.
- `npm run smoke:mcp`: passed with all 33 existing tools and the default Electron runtime.
- `npm run smoke:actions`: passed with the isolated Phase 0 runtime.
- `npm run smoke:runtime`: passed.
- `npm run smoke:advanced`: passed, including the existing visible-PDF no-rerequest Electron flow.
- `npm run smoke:edge`: passed, including reconnect, endpoint removal, profile lock release, and bounded cleanup.
- `npm run smoke:edge-core`: passed. It covers tab create/select/close, `window.open`, `target=_blank`, history/reload, snapshot revisions, stale refs, fill/click/keyboard/select/check/uncheck/scroll, same/cross-origin iframes, alert/confirm/ordinary and sensitive prompts, viewport and element screenshots, sensitive masking, text/URL waits, stop cancellation, signed URL redaction, download completion/cancellation, visible PDF import, document read/search, stop generations, and reconnect invalidation.
- Forced broker-exit cleanup test: the helper reported the abnormal broker exit while still removing the explicit test profile and all Edge processes tied to that profile.
- `npm audit --omit=dev`: passed with 0 vulnerabilities.
- Final cleanup audit: 0 managed Edge profile directories and 0 Edge processes referencing the project test-profile root.
- No renderer source changed, so no new Playwright screenshots were required.

## Known Issues

- Compatibility is currently verified only with Windows Microsoft Edge 150.0.4078.65.
- The CDP transport is loopback-only and ephemeral, but it is not an OS authentication boundary against other same-machine processes.
- This Edge build returns empty synthetic `204` bodies for loopback managed resource loads and loopback PDF viewer response interception. The smoke-only loopback fallback does not apply to real websites; broader attachment/download compatibility needs a later hardened browser-context implementation.
- Snapshot support is intentionally limited to the main frame and one iframe level. Complex nested frames and special shadow DOM compatibility remain future work.
- The Edge broker is a development-switch prototype. Durable broker-restart ownership recovery and Phase 3 challenge/assistance state machines are not implemented.

## Next Steps

- Phase 2 acceptance is complete and the codebase is ready for a separately authorized Phase 3 implementation.
- Phase 3 should add challenge/login detection and durable human-assistance coordination without weakening the Phase 2 adapter, redaction, profile, or transport boundaries.
