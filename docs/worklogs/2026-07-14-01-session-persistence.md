# 2026-07-14 - Session Persistence and Functional Controls

## Objective

Make the desktop controls functional, persist application data across restarts, reduce repeated university authorization, and make authorization state visible and verifiable to both the user and Codex.

## Decisions

- Keep the existing persistent Chromium partition and add an encrypted backup only for session cookies that Chromium normally drops on exit.
- Use Electron `safeStorage`, which binds encrypted cookie recovery to the current Windows user. Never expose cookie values, headers, signed queries, or browser-profile files through MCP.
- Persist sanitized runtime metadata separately from Chromium: tasks, download records, the last safe non-auth page, and save timestamps.
- Treat UI navigation as human control. Pausing Codex blocks MCP automation but does not block the user's address bar, history, refresh, or home controls.
- Verify authorization completion against the visible page and, for protected-resource failures, a session-backed resource probe. Do not clear prompts merely because control resumed.
- Trigger 401/403 authorization alerts only for the main frame; subresource failures must not create notification storms.
- Identify downloaded PDFs by the `%PDF-` signature rather than filename alone. Treat expected-PDF responses that contain HTML as an authorization failure requiring a retry.

## Changes

- Added `src/electron/persistence-service.ts` with atomic runtime-state writes and Windows-encrypted session-cookie backup/restore.
- Restored the last safe page, task history, download records, existing download-directory files, and interrupted task/download states at startup.
- Added graceful shutdown flushing for runtime state, encrypted cookies, and Chromium's cookie store.
- Sanitized persisted URLs and task details; signed/authentication query values are not written to runtime state.
- Fixed the primary button failure by calling the previously defined but unused `setupIpc()` during desktop startup.
- Added manual-navigation IPC paths so user takeover keeps working while Codex is paused.
- Added session health, verified authorization completion, notification deduplication, main-frame 401/403 filtering, and authorization-aware download retry state.
- Correlated `paper_download` job IDs with download/task records and stopped leaving the original request task permanently running.
- Replaced exposed signed download URLs with page-scoped opaque candidate IDs and removed URL query strings from MCP status, observations, snapshots, action results, and errors.
- Serialized MCP and UI navigation, added stop generations and abortable authorization probes, matched concurrent downloads by URL chain, and cancelled late download events after stop/timeout.
- Added persistent tombstones for cleared download records so directory reconciliation does not recreate them after restart.
- Added safe file opening by download/document ID without returning local paths through MCP.
- Hardened `DocumentService` with schema validation, corrupt-index backup, serialized imports, duplicate detection, path boundaries, URL sanitization, rollback cleanup, BOM handling, and atomic `fsync` persistence.
- Reworked the renderer with hydration guards, disabled web-preview controls, home/session/data controls, recent download/document actions, record cleanup, and a browser action strip outside the native view.
- Added `session_check` and `auth_complete`, increasing the MCP tool count from 21 to 23.
- Improved MCP desktop autostart so a crashed desktop can be started again and spawn failures report the exact missing executable or exit reason.
- Updated the `browser-operator` and `paper-research` plugin skills for checked authorization and download retry behavior.
- Updated the personal plugin cache version to `0.1.0+codex.20260713211332` and refreshed README documentation.

## Verification

- `npm run typecheck`: passed.
- `npm run build`: passed for renderer, Electron, and MCP bundles.
- `npm run smoke:mcp`: passed with 23 tools and a successful `session_check` call.
- `npm run smoke:actions`: passed for referenced input, selection, clicking, keyboard delivery, scrolling, waits, and sensitive-password blocking.
- `npm run smoke:runtime`: passed for main-frame 403 retention, stop cancellation, serialized navigation, MCP query redaction, opaque download candidates, out-of-order download matching, and late-download cancellation.
- Actual Electron/CDP button regression passed for home, manual address navigation while paused, pause, resume, session check, authorization verification, and task-history cleanup.
- Authorization fixture regression passed:
  - Calling `auth_complete` while the password form remained visible returned `attention` and kept the banner open.
  - After simulated manual login removed the form, the same UI command returned `healthy`, cleared the prompt, and completed only the associated task.
- Restart recovery regression passed:
  - A harmless session-cookie fixture was encrypted locally.
  - After force-ending and restarting Electron, the last safe page, task/download state, and session cookie were restored.
  - The fixture cookie was then removed and the encrypted backup returned to an empty session-cookie set.
- Playwright snapshots/screenshots passed with zero console errors at 1440x900 and the 980x680 minimum window:
  - `output/playwright/codex-browser-session-1440x900.png`
  - `output/playwright/codex-browser-session-980x680.png`
- Personal plugin validation passed after the final cachebuster update.
- `npm audit --omit=dev`: zero production vulnerabilities.

## Known Issues

- The WindowsApps `codex.exe` remains inaccessible from this PowerShell process, so `codex plugin add codex-browser@personal` cannot complete here. The validated personal marketplace source is ready for the Codex app, and a new task is still required after installation.
- Session health currently verifies the visible page and the last protected resource. Institution-specific health URLs and expiry rules still require a university profile adapter.
- A protected download that returned HTML becomes queued after authorization and must be retried; it is not silently replayed because signed publisher URLs may be one-use or expired.
- The local named pipe currently trusts the signed-in Windows user boundary and has no per-client capability token.
- PDF extraction still runs in-process; stop prevents stale success/error state from overwriting the UI, but it cannot interrupt PDF.js in the middle of a page extraction.
- One Chromium profile and one visible tab are still implemented.

## Next Steps

- Add institution profile management with a configured off-campus URL, health-check URL, and successful-login rules.
- Implement the first real university and publisher/database adapters.
- Add multiple tabs and named profiles while keeping authorization data isolated per profile.
- Add download-to-document IDs to the public summary and optional OCR for scanned PDFs.
