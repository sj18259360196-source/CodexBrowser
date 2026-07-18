# Ordinary Edge Extension Relay

## Objective

Add an opt-in runtime that lets CodexBrowser operate tabs in the user's already-open ordinary Microsoft Edge profile, so existing sign-in state and user-installed compatibility extensions remain available without copying or directly reading the profile directory.

## Decisions

- Use a Manifest V3 Edge extension and `chrome.debugger` as the browser-side CDP transport; do not start ordinary Edge with a remote-debugging port or take ownership of its profile.
- Keep the existing `EdgeBrowserAdapter` and action-safety policy by emulating the small browser/target command surface at the relay boundary and forwarding tab-scoped CDP commands through the extension.
- Bind the broker only to `127.0.0.1` and require a two-minute, user-initiated pairing window plus a random bearer credential. Persist only its SHA-256 hash on the broker side.
- Make the mode explicit and reversible (`edge-extension`), retaining managed external Edge as the default.
- Do not expose managed profile clearing, managed download capture, or PDF-library import in relay mode because ordinary Edge owns that data and download lifecycle.

## Changes

- Added a localhost long-poll relay server, authenticated extension transport, and `ExtensionRelayRuntime` adapter.
- Added an unpacked Edge extension under `extension/edge-relay/` with pairing UI, debugger attachment, target discovery, and CDP event forwarding.
- Added broker lifecycle, runtime selection, capability reporting, pairing, status, and extension-folder APIs.
- Fixed the project launcher to pass the selected runtime to a newly spawned broker instead of always forcing `external-edge`.
- Added control-center UI for selecting the ordinary Edge extension runtime, opening the extension directory, and starting pairing.
- Included the extension in Windows portable packages and documented installation, pairing, security boundaries, and limitations.
- Added relay authentication/queue regressions and updated runtime-selection coverage.
- Preserved the preceding Turnstile and ACS PDF compatibility fixes in the same working session.

## Verification

- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm run test:runtime-selection`: passed, 2/2 tests.
- `npm run test:edge-relay`: passed, 1/1 tests.
- `npm run test:challenge`: passed, 19/19 tests.
- `npm run smoke:edge`: passed against Microsoft Edge 150.0.4078.65, including reconnect, duplicate-profile rejection, endpoint cleanup, and profile-lock release.
- `node --check extension/edge-relay/service-worker.js`: passed.
- `node --check extension/edge-relay/popup.js`: passed; `manifest.json` parsed successfully.
- Renderer Playwright checks passed at 1440x900 and 760x520 with zero console errors or warnings; screenshots are stored in `output/playwright/edge-relay-runtime-*.png`.

## Known Issues

- The extension must be loaded unpacked and paired by the user once before `edge-extension` can connect; the runtime waits up to 60 seconds for that connection.
- A live end-to-end run inside the user's ordinary Edge profile was not performed automatically because loading an extension and approving debugger access require visible user consent.
- Relay mode cannot provide managed download capture/import or destructive profile-data clearing. Ordinary Edge remains the owner of cookies, credentials, extensions, and downloads.
- Edge displays its normal debugging notification while the relay extension is attached to a tab.

## Next Steps

- Restart CodexBrowser, open browser runtime settings, choose `edge-extension`, and use **Open extension folder** plus **Start pairing**.
- In ordinary Edge, load `extension/edge-relay` through `edge://extensions` in developer mode, pin/open the extension, and click its pair button during the pairing window.
- Retry the ACS/Cloudflare page in that ordinary Edge window and complete any visible verification manually.
