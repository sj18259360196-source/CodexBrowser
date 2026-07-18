# ACS Challenge Loop Diagnosis and Fix

## Objective

Explain why an ACS supplementary PDF repeatedly enters Cloudflare verification in managed Edge while the user's ordinary Edge succeeds, and fix the in-scope navigation defect without automating or bypassing the challenge.

## Decisions

- Treat a `.pdf` URL as only a hint. Capture a response only when a successful response is explicitly identified as PDF by its headers.
- Pass publisher HTML challenges, redirects, authentication pages, errors, and their Cookie processing through untouched.
- Keep the dedicated profile boundary for now. Directly reusing the ordinary Edge profile conflicts with the current ownership model, profile locking, modern remote-debugging restrictions, and secret isolation.
- Recommend a separately designed, opt-in ordinary-Edge extension relay if the product is to operate inside the user's existing profile.

## Changes

- Added strict PDF response classification for `application/pdf` and PDF-named `application/octet-stream` downloads.
- Changed PDF navigation interception so non-PDF responses use CDP response continuation instead of body capture and synthetic fulfillment.
- Added regressions covering real PDFs, Cloudflare HTML responses, redirects, error responses, and ambiguous binary responses.
- Included the new PDF/challenge compatibility regressions in `test:challenge`.

## Verification

- Live browser status confirmed the affected tab is running in the dedicated persistent `primary` profile, remains in `WAITING_USER`, and is receiving an ACS Cloudflare challenge at a `.pdf` URL.
- `npm run typecheck`: passed.
- `npm run test:challenge`: passed, 19/19 tests.
- `npm run build`: passed.

## Known Issues

- The currently running broker still contains the previous bundle and must be restarted before this fix is active.
- Direct use of the normal Edge profile is not implemented. It would require closing competing Edge instances and would weaken the existing credential/profile boundary; current Chromium security changes may also reject default-profile remote debugging.
- An extension-relay runtime for ordinary Edge would be a new architecture phase requiring explicit permissions, transport authentication, tab ownership, action policy parity, and rollback tests.

## Next Steps

- Restart Codex Browser and retry the ACS PDF link, completing any visible Turnstile manually.
- If ordinary-profile operation is desired after confirming this fix, design and implement an opt-in Edge extension relay rather than pointing CDP at the default profile directory.
