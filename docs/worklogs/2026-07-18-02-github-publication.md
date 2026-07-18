# GitHub Publication

## Objective

Initialize version control for the completed Codex Browser project and publish its source, documentation, and tests to a new GitHub repository.

## Decisions

- Use `main` as the default branch.
- Publish to the existing public `sj18259360196-source/CodexBrowser` repository.
- Replace the existing remote `main` history with the local project after the user explicitly confirmed that the local checkout is authoritative and current.
- Exclude local Playwright CLI captures and generated release archives from source control.
- Keep the release ZIP and checksum locally; the ZIP is a generated 180 MB artifact and exceeds GitHub's normal per-file limit.

## Changes

- Initialized the previously empty `.git` directory as a Git repository.
- Added `.playwright-cli/` and `release/` to `.gitignore`.
- Prepared the project source, documentation, scripts, and tests for the initial commit.

## Verification

- Credential preflight found no `.env`, private-key, or common token-format files in the upload set.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm run smoke:mcp`: passed; the MCP server started successfully from this project.
- Initial source commit created successfully on `main`.
- Existing remote `main` was force-updated from the user-confirmed authoritative local checkout.
- Local `main` now tracks `origin/main`.

## Known Issues

- The generated portable release archive is not included in the Git repository.

## Next Steps

- Optionally publish the separately retained portable ZIP and checksum as GitHub Release assets.
