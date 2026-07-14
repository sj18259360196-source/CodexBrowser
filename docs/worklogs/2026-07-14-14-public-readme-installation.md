# Public README and installation guide

## Objective

Make the public repository README suitable for new users who need to install, run, and connect Codex Browser without access to the maintainer's local paths or personal plugin marketplace.

## Decisions

- Lead with the supported public installation path instead of the internal MVP feature inventory.
- Document source installation as the current supported route because the GitHub repository has no published Release assets.
- Document direct STDIO MCP setup so public users can connect Codex without the private local plugin package.
- State platform, signing, release, plugin-distribution, and licensing limitations explicitly rather than promising unavailable one-click installation.
- Keep the existing browser-skill, encrypted-session, document, and safety behavior visible in shorter user-focused sections.

## Changes

- Rewrote `README.md` as an install-first public guide.
- Removed maintainer-specific absolute project and plugin paths.
- Added supported Node.js and Windows requirements, clone/build/start commands, direct Codex MCP configuration, first-use examples, privacy boundaries, troubleshooting, development checks, installer-building guidance, and current limitations.
- Added an explicit license-status section because the public repository currently has no `LICENSE` file.
- Added this session record and linked it from `WORKLOG.md`.
- No application source, public plugin package, installed plugin record, or Codex plugin cache was changed.

## Verification

- Confirmed through the public GitHub API that `sj18259360196-source/CodexBrowser` is public and uses `main` as its default branch.
- Confirmed that the repository currently has no GitHub Release assets and no detected license.
- Confirmed Vite's installed Node.js requirement is `^20.19.0 || >=22.12.0`.
- Confirmed the built MCP entry point derives the project root from `dist/mcp/index.mjs` and can launch the source Electron runtime without the maintainer's personal plugin launcher.
- Confirmed official Codex documentation supports local STDIO MCP servers through the desktop settings, CLI, IDE extension, and shared Codex configuration.
- `npm run typecheck` passed.
- `npm run build` passed.
- `npm run smoke:mcp` passed against an isolated current build and reported 38 tools.
- `npm run smoke:actions` passed against an isolated current build.
- `npm run smoke:runtime` passed against an isolated current build.
- `npm run smoke:credentials` passed.
- `npm run smoke:advanced` passed.
- `npm run smoke:skills` passed.
- `npm run smoke:skills-runtime` passed with an isolated temporary named pipe and user-data directory.
- Initial default-pipe MCP and runtime checks reached the already-running older desktop process; rerunning against isolated current builds passed without source changes.
- Confirmed at session end that local `HEAD`, cached `origin/main`, and the public GitHub branch API all report commit `ee5f284a9e04460d01b25cddebc942c60323e67e`.
- Confirmed all README local file references exist and no maintainer-specific absolute paths remain.
- `git diff --check` passed with only the repository's existing LF-to-CRLF conversion warnings.

## Known issues

- A source clone plus manual MCP registration is still required until a tested GitHub Release and public plugin distribution path are published.
- Windows installers produced locally are unsigned and can trigger SmartScreen warnings.
- The repository has no open-source license, so redistribution and modification rights remain undefined until the maintainer selects one.
- The `smoke:skills-runtime` npm script requires caller-provided isolation environment variables; the README does not present it as a direct public command.
- The final `git fetch origin --prune` attempt timed out connecting to GitHub; the public branch API remained reachable and reported the same commit as the local tracking reference.
- Existing unrelated application and branding changes were already present in the working tree and were preserved.

## Next steps

- Select and add an open-source license; MIT is a common permissive choice, while Apache-2.0 additionally includes an explicit patent grant.
- Publish a versioned, tested Windows installer through GitHub Releases.
- Package the Codex MCP launcher and skills in a repo-backed public marketplace or make the installed application expose a stable launcher path.
- Add a security policy and clean-machine installation test before announcing a stable release.
