# Formal Release Packaging

## Objective

Turn the already accepted Codex Browser 1.0.0 codebase into a concrete Windows x64 release artifact with a repeatable packaging command, integrity checksum, accurate prerequisites, and final release documentation.

## Decisions

- Ship a portable Windows x64 archive rather than introducing an installer framework, signing flow, or architectural change after Phase 7 acceptance.
- Keep `external-edge` as the default and retain `electron-legacy` as the explicit rollback.
- Include production dependencies and the Electron control-center runtime in the archive.
- Require Node.js 22.13.0 or newer because the locked PDF.js dependency declares that minimum runtime; do not silently download Node or Edge.
- Keep the personal Codex plugin as a separately installed, already validated component and document how its project root maps to an extracted release.

## Changes

- Added `npm run package:win` and a bounded Windows portable packaging script.
- Added Node version checks and actionable startup errors to the desktop launcher.
- Added 1.0.0 release notes and documented the generated artifact and prerequisites in README.
- The packaging flow creates a versioned ZIP, verifies required entries, writes a SHA-256 checksum, and removes only its validated staging directory.
- Aligned MCP automatic startup with the launcher's bounded 20-second cold-start window after an extracted-package smoke exposed that the previous eight-second window could expire while Edge was still starting.
- Closed each one-request broker pipe socket after writing its response. The extracted-package shutdown smoke exposed that an idle response socket could otherwise keep `pipeServer.close()` waiting and delay broker, Edge, and profile-lock release.
- Extended confirmed managed-Edge graceful-exit waiting from 15 to 30 seconds. A newly extracted package with a fresh profile can still be completing first-run storage initialization when an immediate release smoke requests shutdown; the runtime remains bounded and never force-terminates an unconfirmed process.
- Tracked broker named-pipe sockets and destroys outstanding local connections during explicit broker shutdown. This prevents an abandoned MCP request socket from blocking `pipeServer.close()` before the managed Edge shutdown sequence begins.

## Verification

- `npm run typecheck`: passed.
- `npm run build`: passed.
- Release package creation: passed after routing the locked production install through `cmd.exe` for Windows/Node 24 compatibility.
- Archive integrity validation: passed; required launcher, Electron, broker, MCP, renderer, manifest, and release-note entries were present.
- `npm run smoke:release-package`: passed from the extracted archive with a unique pipe and temporary profile; packaged broker reached ready on Edge 150.0.4078.65, then closed its pipe, Edge process, endpoint, and profile lock and removed all test data.
- `npm run smoke:mcp`: passed with all 39 tools and protocol 1.2.0.
- `npm run smoke:edge-core`: passed for tabs, navigation, snapshots, actions, sensitive blocking, frames, popup, dialogs, screenshot redaction, waits, downloads, PDF import, and reconnect invalidation.
- `npm run smoke:default-runtime`: passed with `CODEX_BROWSER_RUNTIME` unset, external Edge auto-start, owned-browser recovery, and stale-ref invalidation.
- `npm audit --omit=dev`: passed with zero known production vulnerabilities.
- Final artifact: `release/CodexBrowser-1.0.0-win-x64.zip`, 180,689,368 bytes, SHA-256 `45dee6070a7269fea07457bf6eb55503c33b52cf994a1da3e2319617ff339c44`; the adjacent checksum file matches.
- Final cleanup: zero release-smoke directories, temporary profiles, and isolated Edge processes.

## Known Issues

- The project directory contains an empty/nonfunctional `.git` directory, so this session cannot create a Git commit, tag, or remote release.
- The portable archive is not code-signed and is not a Windows installer.
- The personal plugin remains separately installed and must point its project-root setting at the active extracted directory.

## Next Steps

- Distribute the generated ZIP and SHA-256 file through the chosen channel.
- Add code signing or an installer only when a signing identity and distribution channel are explicitly selected.
