# Phase 3 Challenge Detection And Human Takeover

## Objective

Implement only Phase 3: detect challenge and authentication boundaries, freeze only the affected tab, hand control to the user in the managed visible browser, verify completion before resuming, preserve the default Electron runtime, and avoid CAPTCHA solving, credential entry, raw CDP exposure, or Phase 4 data management.

## Decisions

- Kept Electron as the default runtime and retained the Phase 1/2 ephemeral loopback WebSocket transport discovered through `DevToolsActivePort` for `CODEX_BROWSER_RUNTIME=edge-prototype`.
- Used a centralized multi-signal score model. Provider frames, explicit challenge DOM, sensitive controls, and WebAuthn markers are strong evidence; status, classified header names, title, refresh count, and stall duration are supporting evidence.
- Classified a lone 401/403 as blocked access, not Cloudflare. Ordinary checkboxes, slow pages, discussion text, and mixed interactive test pages do not create confirmed challenge assistance.
- Made user completion verifier-driven. `userConfirmed=true` starts verification but never proves success; the system requires fresh page evidence, cleared blocking signals, a material change, and a bounded resource probe when relevant.
- Kept Cookie values completely out of MCP and logs. The Edge verifier does not currently use Cookie-name changes as evidence; it relies on page, status, target, stability, and protected-resource evidence.
- Added a separate Electron control-center process for Edge mode. It communicates only through the private broker pipe and never receives CDP endpoints, target IDs, session IDs, profile paths, Cookie values, or authorization headers.

## Changes

- Added `src/browser/challenge-detector.ts`, `assistance-coordinator.ts`, and `challenge-verifier.ts`.
- Extended shared contracts with `CLOSED`, `TAB_VERIFYING`, assistance challenge/passkey/certificate kinds, `expired`, expiry/domain/strategy metadata, sanitized challenge evidence, and bounded probe results.
- Extended Electron and Edge adapters to collect bounded main-frame/frame/script/DOM evidence without field values or arbitrary headers.
- Added Edge per-tab freeze, assistance baselines, deduplication, priority upgrade, expiry/stale handling, verified resume, stop cancellation, exact-tab activation, and one-time control-center launch.
- Hardened protected-resource checks to HEAD first, GET/Range only after 405, bounded timeout and redirects, limited/no response body, same-session credentials, HTML-login rejection, and signed-URL replay refusal.
- Updated Electron authentication inspection to use the shared score model while retaining its existing session persistence and notification path.
- Updated MCP schemas so both `auth_complete` and `browser_assistance_complete` require explicit user confirmation. Added the new assistance kinds without adding raw CDP, evaluate, Cookie, or authorization tools.
- Updated the renderer to display waiting, verifying, completed, unable, and expired states with `检查并继续`, `无法完成`, and `停止任务` controls.
- Added detector/coordinator unit tests and `scripts/challenge-assistance-smoke.mjs` using only loopback fixtures and a unique managed Edge profile.
- Updated the personal plugin to forbid password, OTP, recovery-code, passkey, CAPTCHA, and Turnstile automation. Official cachebuster is `0.1.0+codex.20260717061603`.

## Verification

- Phase 2 preflight `npm run smoke:edge-core`: passed before implementation.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm run smoke:mcp`: passed, 33 tools, default Electron runtime.
- `npm run smoke:actions`: passed with isolated profile.
- `npm run smoke:runtime`: passed.
- `npm run smoke:advanced`: passed after updating the smoke to provide explicit user confirmation.
- `npm run smoke:tab-policy`: passed.
- `npm run smoke:blocked-restart`: passed; restart restores only sanitized boundary metadata and re-detects page state.
- `npm run smoke:edge`: passed on Microsoft Edge `150.0.4078.65`; endpoint removed and profile lock released.
- `npm run smoke:edge-core`: passed all Phase 2 browsing checks after Phase 3 integration.
- `npm run smoke:challenge`: passed tab freeze, other-tab operation, stale action rejection, failed verification, verified resume, explicit confirmation, notification deduplication, stop cancellation, and sensitive exposure checks.
- `npm run test:adapter`, `npm run test:challenge`, `npm run test:tab-policy`, and `npm run test:persistence`: passed.
- `npm audit --omit=dev`: passed with 0 vulnerabilities.
- Playwright renderer checks passed at `1280x800` and `760x520`; no console errors or warnings. Screenshots: `output/playwright/phase3-assistance-standard.png` and `output/playwright/phase3-assistance-minimum.png`.
- Post-smoke process audit found no managed Edge or `edge-control-center` process and no managed profile lock.
- Personal plugin manifest and both skills passed the official validators. `codex plugin add codex-browser@personal` was attempted and failed because the WindowsApps `codex.exe` entry point returned access denied.

## Known Issues

- Detection intentionally covers the main frame and first-level provider/frame evidence; complex nested frames and unusual closed shadow DOM remain later compatibility work.
- Native Edge tab focus uses `Target.activateTarget` plus window restoration. Windows may still apply normal foreground-activation restrictions; the implementation does not repeatedly steal focus.
- The protected-resource verifier refuses one-time signed URLs and cannot use them as a probe. It waits for page/target evidence instead.
- Cookie-name changes are not yet used by the external Edge verifier. This avoids pulling Phase 4 Cookie management forward, but can make some completed sessions require stronger page or resource evidence.
- The personal plugin source is validated and cache-busted, but CLI reinstall is blocked by the local WindowsApps executable permission. A Codex app reload/new task is required to consume the updated plugin copy.

## Next Steps

- Reload the validated personal plugin in the Codex app before relying on the updated skill wording in a new task.
- Phase 3 is ready for acceptance. Begin Phase 4 only under a separate explicit request; no Cookie/data management or general high-risk action policy was implemented here.
