# Node Version Launcher Fix

## Objective

Fix the installed launcher incorrectly rejecting Node.js 24.15.0 even though Codex Browser requires Node.js 22.13 or newer.

## Decisions

- Remove the inline JavaScript expression from the Windows batch file because command-shell metacharacter escaping made the check fragile.
- Use a dedicated `.mjs` checker with explicit major/minor comparison and unit coverage.
- Package the checker in both the portable ZIP and EXE installer.

## Changes

- Added `scripts/check-node-version.mjs` and changed `start-desktop.cmd` to invoke it.
- Added regression cases for Node 22.13, Node 24.15, future major versions, older versions, and malformed input.
- Included the checker in the formal portable payload and installer source.

## Verification

- `npm run test:launcher`: passed, 2/2 tests.
- Direct execution with Node 24.15.0: passed with exit code 0.
- `npm run typecheck`: passed.
- `npm run package:installer`: passed, including the production build, portable ZIP, and EXE installer.
- The final ZIP contains `scripts/check-node-version.mjs`.
- `npm run smoke:installer`: passed. The installed checker accepted Node 24.15.0, required runtime and extension files were present, and uninstall cleanup completed.
- Final installer size: 115,318,917 bytes. SHA-256: `e5746ea62deb8f7f53bff947f74cde8fb0d6fed05383dd2ff47c5d765451b82e`.
- Fix commit `bddf682` was pushed to PR #2 together with the previously pending publication log.
- The 1.1.0 draft GitHub Release assets were replaced with the launcher-fixed ZIP, EXE, and checksums. GitHub reports all assets in `uploaded` state and reports the EXE digest as `e5746ea62deb8f7f53bff947f74cde8fb0d6fed05383dd2ff47c5d765451b82e`.

## Known Issues

- Node.js remains an external prerequisite and is not bundled by the installer.
- The installer remains unsigned, so Windows SmartScreen may display an unknown-publisher warning.

## Next Steps

- Review and merge PR #2, then publish the launcher-fixed 1.1.0 draft Release.
