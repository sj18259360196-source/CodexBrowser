# Turnstile Compatibility Hardening

## Objective

Diagnose the intermittent Cloudflare Privacy Pass Turnstile failure shown in the supplied screenshots and remove Codex Browser behaviors that could disturb verification-provider browser signals.

## Decisions

- Treat Turnstile, reCAPTCHA, and hCaptcha frames as human-only trust boundaries: their URLs may identify a challenge, but snapshots must not create isolated JavaScript worlds inside them.
- Keep ordinary same-origin and cross-origin iframe observation unchanged.
- Scope CDP focus emulation to the single trusted keyboard operation that needs it, then restore native focus reporting.
- Do not disable user extensions or attempt to solve/retry challenges automatically. Provide a targeted translation/content-blocker troubleshooting hint instead.

## Changes

- Added verification-provider iframe URL classification for Cloudflare, reCAPTCHA, and hCaptcha.
- Skipped script-based snapshot and element discovery inside classified verification frames while retaining visual rendering and manual operation.
- Replaced persistent focus emulation with a bounded enable/disable wrapper around keyboard input.
- Added focused classification regressions and included them in `test:challenge`.
- Updated Cloudflare assistance text and README troubleshooting guidance for generic failures associated with translation or content-blocking extensions.

## Verification

- Live managed Edge 150 opened the Cloudflare Privacy Pass demo and rendered a normal human-verification checkbox; no challenge interaction was automated.
- `npm run typecheck`: passed.
- `npm run test:challenge`: passed, 17/17 tests.
- `npm run build`: passed repeatedly.
- Existing personal plugin manifest and both plugin skills passed their official validators.
- `smoke:edge-core` and `smoke:challenge` were attempted repeatedly but the current Edge environment aborted their first loopback HTTP navigation with `net::ERR_ABORTED` before reaching the changed paths.
- `smoke:mcp` was attempted but the isolated Electron process exited before opening its private pipe in the managed execution environment; the already-running plugin MCP remained healthy and callable.

## Known Issues

- The screenshots do not expose a Turnstile numeric error code, so page translation is a strong correlation rather than a uniquely proven external root cause. Cloudflare also documents extensions, network conditions, cache/clock state, and bot-signal failures as possible causes.
- Full isolated GUI smokes remain blocked by the current desktop execution environment as described above; the deterministic regression and build checks pass.
- The currently running managed Edge broker must be restarted before it loads the rebuilt adapter bundle; existing tabs were deliberately not closed automatically.

## Next Steps

- Restart Codex Browser at a convenient time, revisit the Privacy Pass demo without whole-page translation, and complete the checkbox manually.
- If failure recurs, record the six-digit Turnstile error code and whether translation/content-blocking extensions were enabled so the remaining external cause can be distinguished.
