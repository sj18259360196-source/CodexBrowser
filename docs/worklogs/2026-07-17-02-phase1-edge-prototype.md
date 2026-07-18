# 2026-07-17 - Phase 1 Edge Runtime Prototype

## Objective

Implement and verify the minimum independent Microsoft Edge runtime loop behind an explicit development switch without changing the default Electron runtime or beginning Phase 2 browsing parity.

## Decisions

- Keep Electron as the default runtime; select the prototype only with `CODEX_BROWSER_RUNTIME=edge-prototype` and the isolated `smoke:edge` command.
- Use an ephemeral debugging port bound to `127.0.0.1`, discovered from the managed profile's `DevToolsActivePort` file, because it produced a stable Windows/Edge Phase 1 loop.
- Keep CDP endpoint data and raw target/session identifiers inside the runtime and transport modules; expose only internal tab IDs and the fixture page title/URL.
- Use only visible Edge, a dedicated temporary `user-data-dir`, and the minimum first-run/debugging flags. Do not disable the sandbox, certificate checks, same-origin security, or other browser protections.
- Permit graceful shutdown only for the process whose PID was returned by this runtime's own spawn operation.

## Changes

- Added the browser runtime contract and runtime selection parser.
- Added Windows Edge discovery, environment override support, executable validation, and file-version reporting.
- Added bounded `.runtime/edge-profiles/phase1-*` profile creation, exclusive lock acquisition, duplicate-start rejection, release, and path-validated cleanup.
- Added an internal loopback WebSocket CDP transport with request correlation, event waits, disconnect, and reconnect.
- Added the Edge runtime lifecycle: `start`, `attach`, `status`, `show`, and graceful `shutdown`.
- Added minimal target discovery, opaque internal tab IDs, test-tab creation, local navigation, title/final URL reads, tab close, and reconnect rediscovery.
- Added `build:edge-prototype` and `smoke:edge`; updated the full build, README, plan progress, and work-log index.

## Verification

- Compatible browser: Microsoft Edge 150.0.4078.65 on Windows.
- CDP transport: ephemeral loopback WebSocket on `127.0.0.1`, discovered through `DevToolsActivePort`.
- `npm run typecheck`: passed.
- `npm run build`: passed for renderer, Electron, Edge prototype, and MCP.
- `npm run smoke:mcp`: passed; 33 existing MCP tools remained available through the default Electron runtime.
- `npm run smoke:runtime`: passed.
- `npm run smoke:advanced`: passed.
- `npm run smoke:actions`: passed; it uses the Phase 0 isolated profile/pipe infrastructure.
- `npm run smoke:edge`: passed after final changes. It verified discovery, unique profile lock, duplicate-profile rejection, visible launch, CDP readiness, local fixture navigation, title/URL reads, disconnect/reconnect, tab rediscovery, tab close, graceful exit, endpoint removal, lock release, and bounded profile deletion.
- `npm audit --omit=dev`: passed with 0 vulnerabilities.
- Final cleanup audit found no Phase 1 profile contents and no Edge process using the project test-profile path.
- No renderer files changed, so no new Playwright screenshots were required.

## Known Issues

- The Phase 1 prototype supports Windows Edge only and was compatibility-tested against Edge 150.0.4078.65.
- The fallback CDP port is loopback-only and ephemeral, but it is not an OS authentication boundary against other same-machine processes.
- Attach/reconnect is intentionally limited to the Edge process already confirmed and retained by the current runtime object; persistent broker-restart ownership recovery is not implemented in this minimum prototype.
- The Edge adapter intentionally omits snapshots, arbitrary actions, JavaScript execution, iframes, screenshots, downloads, PDF handling, challenge/login detection, Cookie management, and password management.

## Next Steps

- Phase 1 acceptance is complete and the architecture is ready for a separately authorized Phase 2 implementation.
- Before Phase 2, retain the current bounded transport and profile ownership rules; add browsing parity incrementally without exposing raw CDP or browser secrets.
