# Phase 7 Real-Use Acceptance And Release

## Objective

Perform release acceptance and stability hardening on the completed external Edge architecture without adding a new browser engine, automation framework, challenge bypass, password manager, or large UI redesign.

## Decisions

- Existing local fixtures remain the deterministic acceptance source; real-site checks are limited, supervised, low-frequency, and do not use real credentials or consequential actions.
- Reproducible failures receive the smallest targeted fix that preserves Phase 0 through Phase 6 safety boundaries.
- Endurance and canary tests use unique temporary profiles, private transports, local files, and synthetic secrets only.
- `electron-legacy` remains the controlled rollback path and never shares Edge profile data.

## Changes

- Created the Phase 7 release checklist under `docs/release/phase7-checklist.md`.
- Added repeatable Phase 7 endurance, security-canary, broker-recovery, and supervised public-site acceptance harnesses.
- Centralized application, MCP protocol, profile schema, runtime metadata, and minimum Edge compatibility metadata and added release tests.
- Fixed Edge 150 trusted keyboard/select/scroll focus, execution-context routing by session, legacy screenshot fallback, and additional sensitive text/URL/error redaction found during acceptance.
- Made managed Edge disable background residency so graceful shutdown releases the dedicated profile, and made Windows ownership discovery compatible with Windows PowerShell 5 while failing closed when process inspection fails.
- Added stale-broker recovery that reattaches only a uniquely confirmed Edge main process with the exact managed profile and private debugging flag; it never scans or terminates ordinary Edge.
- Moved HTTP-cache clearing ahead of origin/service-worker teardown to avoid an Edge CDP session-detach timeout during all-data clearing.
- Hardened the 30-minute stability harness so an explicit connection-loss boundary skips an uncertain click, performs bounded read-only recovery, and never replays the mutation.
- Expanded the supervised public matrix with a controlled public PDF download/import category.

## Verification

- `npm ci`, `npm run typecheck`, and `npm run build` passed on the final dependency tree.
- Adapter, tab-policy, auth-evidence, challenge, persistence, storage, policy, runtime-selection, release-info, redaction, and sensitive-field suites passed.
- Default/legacy MCP, action, runtime, advanced, tab-policy, blocked-restart, and sensitive suites passed. The MCP surface contains 39 controlled tools.
- Phase 1 Edge, Phase 2 core browsing, Phase 3 challenge/assistance, Phase 4 storage/profile, Phase 5 policy/confirmation, Phase 6 default-runtime, broker-recovery, and storage race-regression smokes passed with isolated profiles and private transports.
- The 30-minute stability run completed 185 iterations, replaced the owned Edge at midpoint, reported zero transient recoveries on the final run, and ended below its peak memory/handle sample.
- The 60-minute endurance run completed 1,057 iterations, 17 broker reconnects, 8 browser recoveries, 36 popups, 53 screenshots, 24 downloads, and 12 PDF imports. Maximum attached page sessions stayed at 6 and resources showed periodic recovery rather than sustained growth.
- Security canary validation checked 12 deterministic fake secrets, 15 MCP payloads, broker logs, and artifact directories with zero leaks.
- The supervised public matrix accepted 10 categories: static, search, documentation, Cookie-capable, login entry, SSO entry, challenge demo, PDF, controlled download/import, and iframe. No credentials or consequential actions were used.
- Renderer Playwright artifacts cover first run, connecting/error/reconnecting, assistance/verifying, confirmations and outcome unknown, storage/reset, legacy, standard/minimum/high-DPI, and long Chinese text with zero observed console errors.
- Personal plugin cachebuster `0.1.0+codex.20260717163939`, manifest, browser operator skill, and paper research skill passed official validation. Live plugin calls reported protocol `1.2.0`, `external-edge` ready on Edge 150, opened/snapshotted/closed a neutral test tab, and returned an empty document list safely.
- `npm audit --omit=dev` reported 0 production vulnerabilities. Final cleanup found 0 isolated Edge processes, 0 temporary Phase 1 profiles, and no listener on the renderer test port.

## Known Issues

- Origin-scoped permission reset is still unavailable on the tested Edge CDP version.
- Deep nested iframe and unusual shadow DOM behavior remains best-effort beyond the one-level compatibility target.
- Personal plugin CLI reinstall remains blocked by the local WindowsApps executable permission; the validated cachebuster is loaded after Codex app reload and current live plugin calls passed.
- Real MFA, passkey, certificate, permission, and native file-picker completion was not exercised with a real account/device. These flows remain visible user-operated boundaries; deterministic local fixtures cover detection, freeze, verification failure, safe resume, and non-replay.
- The supervised public-site matrix is network-dependent and intentionally read-only; it complements rather than replaces local deterministic fixtures.

## Next Steps

- Release version 1.0.0 for routine use with `external-edge` as default and retain `CODEX_BROWSER_RUNTIME=electron-legacy` as the documented troubleshooting rollback.
- Monitor real user-operated MFA/passkey/certificate/file-picker cases and Edge-version compatibility without adding bypass or automatic sensitive-UI handling.
