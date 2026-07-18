# Phase 6 External Edge Default Cutover

## Objective

Make the dedicated external Microsoft Edge runtime the normal default, retain a controlled `electron-legacy` fallback, finalize startup/recovery/settings/UI/plugin/docs, and complete release verification without deleting useful rollback code.

## Decisions

- Unset `CODEX_BROWSER_RUNTIME` selects `external-edge`. Explicit fallback is `electron-legacy`; `edge-prototype` and `electron` remain temporary aliases with migration notices.
- Edge startup failure is explicit and never silently falls back to legacy.
- The default uses the owned long-lived `primary` profile; tests continue using unique `.runtime` profiles and private transports.
- MCP auto-starts or reuses the local broker and managed Edge. Concurrent starts converge on the private pipe/profile lock.
- A live managed Edge with a lost CDP connection is reattached. A confirmed exited managed Edge receives one bounded replacement. Old refs, assistance, confirmations, and grants are invalidated; executing high-risk actions become `outcome_unknown`.
- Legacy stays available for one acceptance period and never shares or overwrites Edge profile data.

## Changes

- Added formal runtime selection/settings modules, persisted safe settings, launcher reuse/autostart, `npm start`, `start:legacy`, and updated local scripts.
- Added runtime/profile state contracts and control-center show/start, restart, stop, first-run, ready/connecting/reconnecting/error, legacy warning, and settings UI.
- Strengthened profile ownership with browser PID, conservative stale-lock recovery, and correct lock descriptor rewrites.
- Added transport-aware runtime health checks, same-process reattach, bounded owned-process recovery, safe shutdown races, and old-ref invalidation.
- Added formal `external-edge` capability reporting and explicit `electron-legacy` capability reporting.
- Added runtime-selection/profile tests, `smoke:default-runtime`, and a 30-minute isolated `smoke:stability` with local tabs, repeated actions/snapshots/navigation, resource sampling, and owned Edge recovery.
- Updated the personal plugin for the Edge default, actual download tools, human assistance, confirmation/grant rules, and secret boundaries.
- Replaced outdated README prototype guidance with daily startup, profile/data, assistance, confirmation, recovery, troubleshooting, and rollback instructions.

## Verification

- Microsoft Edge compatibility: 150.0.4078.65 on Windows using an ephemeral loopback WebSocket endpoint discovered from `DevToolsActivePort`; endpoint details remain private.
- Default-runtime smoke proves unset environment selects `external-edge`, MCP auto-starts it, aliases migrate, an owned Edge exit recovers, and old refs fail.
- Electron legacy MCP/actions/runtime/advanced and sensitive-field tests pass; Edge Phase 1 through Phase 5 smokes pass.
- Renderer Playwright passed first-run, connecting, error, reconnecting, ready-state inherited panels, legacy warning, runtime settings, assistance, confirmation, storage, standard/minimum sizes, long text, keyboard focus, and zero console errors. Artifacts are under `output/playwright/`.
- The 30-minute stability smoke completed 185 iterations across multiple local tabs, recovered after one confirmed owned Edge exit, and showed no sustained resource growth: combined working set peaked around 382 MiB and ended at 366 MiB; handles peaked at 3213 and ended at 2946.
- `npm audit --omit=dev` found 0 vulnerabilities. Cleanup found no isolated managed Edge process, broker process, test profile lock, or unremoved test profile.
- Personal plugin manifest and both skills passed the official validators with cachebuster `0.1.0+codex.20260717100435`; the MCP smoke reports 39 tools. CLI reinstall was attempted and remains blocked by WindowsApps `codex.exe` access denial, so the Codex app must reload the validated local plugin for a new task.

## Known Issues

- The tested Edge version still lacks reliable origin-scoped permission reset; current-site permission clearing remains disabled while all-data clearing resets permissions.
- External Edge and legacy Electron intentionally have separate login/profile state. No raw Chromium browser data is migrated.
- Complex deeply nested iframes and unusual shadow DOM remain best-effort beyond the established one-level compatibility boundary.
- The legacy adapter remains intentionally present until a later acceptance decision; no automatic fallback occurs.

## Next Steps

- Use the default runtime for daily acceptance while retaining `electron-legacy` for controlled troubleshooting.
- Consider legacy adapter removal only after a separate acceptance decision; no new phase or removal work is started here.
