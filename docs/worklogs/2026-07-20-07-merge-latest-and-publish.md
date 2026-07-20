# Merge Latest And Publish

## Objective

Consolidate the latest Codex Browser work onto `main`, preserve the current worktree changes, verify the combined result, and publish the updated branches to GitHub.

## Decisions

- Treat `agent/edge-extension-relay-1.1.0` as the latest branch because it is a linear descendant of `main` by six commits before this session's changes.
- Commit the reviewed worktree changes on the feature branch before merging so no local work is lost.
- Fast-forward `main` to the verified feature-branch commit instead of creating an unnecessary merge commit.
- Include the existing July 20 worklogs and literature smoke scripts after checking that they contain no credentials, tokens, cookies, authorization headers, or raw browser profile data.

## Changes

- Consolidated relay/profile stability fixes, deterministic unit coverage, and literature smoke workflows into the latest branch state.
- Added the complete `test:unit`, `smoke:literature`, and `smoke:literature-batch` npm scripts.
- Recorded the July 20 implementation and verification sessions in `WORKLOG.md`.
- Fast-forwarded `main` to the latest verified feature-branch commit and prepared both branches for GitHub publication.

## Verification

- `npm run typecheck`: passed.
- `npm run test:unit`: passed with 2 adapter tests, 165 core tests, and 2 launcher tests.
- `npm run build`: passed.
- `npm run test:edge-relay`: passed with 3 tests.
- `npm run smoke:mcp`: discovered all 39 tools, but failed because the isolated Electron runtime timed out on `browser.status` and `session.check`, then could not fully remove its locked temporary profile during cleanup.
- Reviewed all untracked worklogs and smoke scripts for sensitive data before staging.

## Known Issues

- GitHub fetch was attempted twice and both HTTPS connections were reset before remote state could be refreshed.
- The MCP smoke remains sensitive to an unresponsive local Electron runtime and a locked temporary profile during cleanup.

## Next Steps

- Confirm the final GitHub push result and retry remote publication when connectivity is available if required.
- Investigate the isolated Electron smoke cleanup path if the MCP timeout repeats in a clean runtime session.
