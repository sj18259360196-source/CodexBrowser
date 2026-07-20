# FontBox Uninstalled Font Preview CORS Fix

## Objective

Restore FontBox previews for fonts saved in the FontBox library but not installed in Windows.

## Decisions

- Keep the existing `fontbox-font://face/<faceId>` protocol so renderer code does not receive local font paths.
- Enable CORS for the custom scheme and explicitly allow the renderer origin on successful font responses.
- Validate with a real library TTF under Electron 43, then verify the running FontBox renderer through CDP.

## Changes

- Updated `A:\Project\FontBox\src\main\protocol\fontPreviewProtocol.ts` to register `fontbox-font` with `corsEnabled: true`.
- Added `Access-Control-Allow-Origin: *` to successful font responses.
- Rebuilt and restarted FontBox so the main-process protocol change is active.
- Stored the verification screenshot at `A:\Project\FontBox\output\playwright\font-preview-cors-fixed.png`.

## Verification

- `npm run typecheck` passed in `A:\Project\FontBox`.
- `npm run build` passed in `A:\Project\FontBox`.
- Before the fix, Electron 43 reported that `fontbox-font://face/test` was blocked by CORS and the protocol handler received no request.
- After the fix, the protocol handler received the request and `document.fonts.load()` returned one loaded face.
- Running FontBox reported `document.fonts.status = loaded`, 279 preview elements, zero loading indicators, and zero preview errors.
- Visual inspection confirmed distinct saved-but-uninstalled fonts render on their cards.

## Known Issues

- TTC previews still rely on Chromium's default selection within a font collection; this change does not add face-level TTC extraction.
- The current preview failure UI does not expose the underlying Chromium error to users.

## Next Steps

- Add a repository-owned Electron protocol smoke test if FontBox adopts a formal test runner.
- Consider logging preview protocol failures to FontBox operation logs for easier diagnosis.
