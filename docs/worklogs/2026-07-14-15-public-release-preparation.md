# Public v0.1.1 release preparation

## Objective

Prepare the current Codex Browser changes for a public Windows preview release that can be installed, verified, and developed without the maintainer's personal filesystem or plugin setup.

## Decisions

- Use the MIT License with `Codex Browser contributors` as the copyright holder.
- Publish `0.1.1` as an unsigned alpha preview and provide a SHA-256 checksum.
- Keep source-based direct MCP registration as the public Codex integration path until a repo-backed plugin or installed launcher is available.
- Make repository smoke scripts launch the built MCP server directly and use isolated temporary browser profiles.
- Work on `codex/public-v0.1.1` instead of pushing the mixed release changes directly to `main`.

## Changes

- Added `LICENSE` and `SECURITY.md`.
- Added repository, issue tracker, license, author, and supported Node.js metadata to `package.json`.
- Added a shared isolated smoke-runtime helper that derives all paths from the repository.
- Removed maintainer-specific project and personal-plugin paths from MCP, action, runtime, advanced, and browser-skill runtime smoke scripts.
- Made the common MCP, action, runtime, and browser-skill runtime smoke commands self-contained and isolated.
- Added `smoke:package` to launch the unpacked packaged application and verify it through the built MCP server with an isolated profile.
- Reworked Windows packaging into a two-stage helper that waits for the unpacked executable and `app.asar` to stabilize before building NSIS from the prepackaged directory.
- Updated the README for GitHub Release installation, checksum verification, MIT licensing, security reporting, and the direct browser-skill runtime smoke command.
- Replaced the user-specific plugin path in `AGENTS.md` with `%USERPROFILE%`.
- Added this session record and linked it from `WORKLOG.md`.

## Verification

- Confirmed `gh` 2.96.0 is authenticated as `sj18259360196-source`; the public repository reports `ADMIN` permission and no existing releases or tags.
- `npm run typecheck` passed.
- `npm run build` passed.
- Repository-only `npm run smoke:mcp` passed with 38 tools and no personal plugin launcher.
- Self-contained `npm run smoke:actions` passed without a pre-existing Vite server.
- Self-contained `npm run smoke:runtime` passed with an isolated profile and named pipe.
- `npm run smoke:credentials`, `npm run smoke:advanced`, and `npm run smoke:skills` passed.
- Self-contained `npm run smoke:skills-runtime` passed without caller-provided environment variables.
- `npm run smoke:package` passed against `release/win-unpacked/Codex Browser.exe`, protocol `1.3.0`, and 23 runtime capabilities.
- `npm run installer:win` passed through the final two-stage packaging helper and produced the assisted x64 NSIS installer.
- A silent install smoke returned exit code 0, created the packaged application, and the silent uninstaller returned exit code 0.
- Final installer: `Codex-Browser-Setup-0.1.1-x64.exe`, 119,914,296 bytes, product/file version `0.1.1`, unsigned as documented.
- Final SHA-256: `04351916bad4777227b3a8bcac83d6b83b1c8d4a35f37425ef840b00a7dc1cd8`.
- `npm audit --omit=dev` reported zero production vulnerabilities.
- The complete audit reports one low-severity development-only `esbuild` advisory; `npm audit fix` has no compatible change because the current latest `tsup` requires `esbuild ^0.27.0`.
- Confirmed Windows Defender recorded no threat detection during the observed A-drive packaging race.

## Known issues

- The Windows installer is not code-signed and can trigger SmartScreen warnings.
- The public one-click Codex plugin is not packaged yet; installed desktop users still need the source checkout for direct MCP registration.
- The latest toolchain currently carries one low-severity development-only `esbuild` advisory affecting a local Windows development server; production dependencies audit clean and Vite binds to `127.0.0.1`.
- The installer passed local silent install/uninstall and packaged runtime checks but has not been tested manually on a separate clean Windows machine.
- Historical work logs retain development-machine paths as session history; no credentials, cookies, authorization headers, or browser-profile data are recorded.

## Next steps

- Run the complete verification suite using the repository-only smoke paths.
- Build and inspect the Windows installer and checksum.
- Review the complete public diff for secrets and generated-file hygiene.
- Commit and push the release branch, then open a draft pull request.
- Publish the preview Release after the release commit is accepted on the default branch.
