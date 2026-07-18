# Codex Browser 1.1.0

Codex Browser 1.1.0 adds an opt-in ordinary Microsoft Edge extension relay while retaining the dedicated managed Edge runtime as the default. It also fixes the ACS publisher-PDF interception path that could keep Cloudflare verification in a reload loop.

## Highlights

- Added the `edge-extension` runtime for operating tabs in the user's already-open ordinary Edge Profile.
- Added a Manifest V3 relay extension using Edge's visible debugger permission and an authenticated localhost-only broker.
- Preserved existing sign-in state and user-installed extensions without copying or directly reading Profile files.
- Stopped inspecting verification-provider iframes and bounded focus emulation around visible human challenges.
- Captures only responses confirmed as PDFs; Cloudflare HTML, redirects, authentication pages, and errors now pass through untouched.
- Fixed the local launcher so a newly spawned broker receives the selected runtime instead of always forcing `external-edge`.

## Install And Start

The Windows x64 portable package requires Windows, Microsoft Edge 109 or newer, and Node.js 22.13.0 or newer. Extract the archive to a writable directory and double-click `start-local.cmd`.

The default `external-edge` runtime needs no extension. To use the ordinary Edge Profile:

1. Open `edge://extensions`, enable developer mode, and load the packaged `extension/edge-relay` directory as an unpacked extension.
2. In Codex Browser runtime settings, open the two-minute pairing window.
3. Click the extension icon in ordinary Edge and connect it to the local broker.
4. Select `edge-extension` and restart Codex Browser.

## Security And Limitations

- The relay listens only on `127.0.0.1`, accepts only an extension origin during explicit pairing, and stores only a SHA-256 credential hash on the broker side.
- Cloudflare, Turnstile, login, MFA, passkey, certificate, permission, and native file-selection steps remain visible user actions and are not bypassed.
- Ordinary Edge owns cookies, passwords, extensions, history, and downloads. Relay mode therefore does not expose managed Profile clearing or automatic PDF-library import.
- Edge displays its normal debugging notification while a tab is attached.

## Verification

The 1.1.0 delta passed TypeScript checking, production builds, runtime-selection and relay authentication tests, 19 challenge/PDF compatibility regressions, Edge lifecycle smoke testing, two-viewport renderer checks with zero console errors, release archive extraction smoke testing, and personal-plugin validation.

See `README.md` for operating guidance and remaining limitations.
