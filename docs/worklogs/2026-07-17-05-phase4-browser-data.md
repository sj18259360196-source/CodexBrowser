# Phase 4 Browser Data And Profile

## Objective

Implement the Phase 4 browser-data lifecycle without starting Phase 5 or Phase 6: a dedicated persistent Edge profile, normal browser storage and password behavior, aggregate storage status, explicit data clearing, safe profile reset, optional Electron session recovery, renderer controls, isolated tests, and plugin guidance.

## Decisions

- Microsoft Edge remains development-only behind `CODEX_BROWSER_RUNTIME=edge-prototype`; Electron remains the default runtime.
- Production Edge uses one Codex Browser-owned `primary` profile under Windows local application data. Test profiles remain unique children of `.runtime/edge-profiles`.
- Edge owns Cookie, Local Storage, IndexedDB, cache, service workers, passwords, autofill, and browser settings. The project does not parse Chromium `Cookies` or `Login Data` databases.
- MCP receives only aggregate storage/profile status. Destructive actions remain behind private desktop IPC/broker calls and a one-time 60-second user confirmation.
- Electron session recovery is disabled by default, encrypted with Windows user-bound safe storage when enabled, profile-bound, and limited to a 5-minute to 24-hour TTL range with an 8-hour default.
- Edge 150 requires Storage/Network clearing commands on a page CDP session. Reliable origin-scoped permission reset is unavailable, so current-site clearing does not issue the global permission reset; all-data clearing does.

## Changes

- Added profile ownership, locking, controlled archival/removal, primary-profile resolution, persistent runtime reuse, and profile reset/restart.
- Added browser adapter storage summary, current-site clearing, all-data clearing, Cookie/session aggregate counts, approximate usage, revision invalidation, and safe session-health integration.
- Added `BrowserDataConfirmationStore`, storage/profile shared contracts, Electron IPC/preload/control-center wiring, and read-only `browser_storage_summary` / `browser_profile_status` MCP tools.
- Reworked Electron session recovery into explicit configuration plus profile-bound encrypted envelopes; invalid, expired, mismatched, and legacy payloads fail closed or are quarantined.
- Added deny-by-default Electron permission assistance and reset behavior for full data clearing.
- Added the renderer browser-data dialog, aggregate summary, recovery explanation, explicit action names, confirmation sheets, progress/success/error states, and responsive layouts.
- Added profile/confirmation/recovery unit tests and an isolated two-origin Edge smoke covering persistence, clearing, redaction, one-time confirmation, and reset.
- Updated the personal plugin safety guidance and cachebuster without adding destructive MCP tools.

## Verification

- Phase 3 challenge smoke passed before Phase 4 implementation and is included again in the final verification matrix.
- Focused checks passed: TypeScript, BrowserAdapter tests, 10 Phase 4 policy/profile tests, and the isolated Phase 4 storage/profile smoke.
- The storage smoke verified persistent Cookie and site storage across normal Edge restart, normal session-Cookie semantics, current-site isolation, all-data clearing, password/OTP snapshot suppression, screenshot redaction, confirmation reuse rejection, profile reset, process exit, endpoint closure, lock release, and bounded test-profile cleanup.
- Playwright checked 1440x900 and 980x680 layouts, long domains, large values, current-site/all-data/profile-reset confirmations, loading/success/error states, keyboard focus, and console output. Screenshots are under `output/playwright/`; console result was 0 errors and 0 warnings.
- Microsoft Edge compatibility: 150.0.4078.65 using an ephemeral loopback CDP WebSocket discovered from `DevToolsActivePort`; no endpoint details are exposed.
- Personal plugin manifest and both skills passed official validators. Cachebuster: `0.1.0+codex.20260717071800`. CLI reinstall remains blocked by WindowsApps `codex.exe` access denial.
- Final verification passed: `npm run typecheck`, `npm run build`, adapter/tab-policy/auth-evidence/challenge/persistence/redaction/storage tests, `npm run smoke:mcp`, `npm run smoke:actions`, `npm run smoke:runtime`, `npm run smoke:advanced`, `npm run smoke:edge`, `npm run smoke:edge-core`, `npm run smoke:challenge`, `npm run smoke:storage`, and `npm audit --omit=dev`.
- The production dependency audit found 0 vulnerabilities. The final cleanup audit found 0 managed test Edge processes, 0 test profile locks, 0 test backup directories, and no remaining renderer preview listener.

## Known Issues

- Edge 150 does not provide a reliable origin-scoped permission reset through the current CDP implementation. Current-site permission clearing is disabled and disclosed in the UI; clearing all data resets permissions.
- Storage-size estimates can be unavailable or approximate and never block normal browsing.
- Custom encrypted session recovery is Electron-only. External Edge uses normal browser session behavior.
- Automatic restoration of an archived profile after a failed reset is not attempted. The archive is preserved with a recoverable status so unknown data is never deleted automatically.
- The validated personal plugin source requires an app reload/new task because CLI reinstall is blocked by the local WindowsApps executable permission.

## Next Steps

- Reload the Codex app before relying on the updated personal plugin wording.
- Begin Phase 5 only after a separate explicit request. No general high-risk action authorization or default-runtime switch was implemented in this session.
