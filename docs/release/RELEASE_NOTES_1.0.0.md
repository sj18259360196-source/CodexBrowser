# Codex Browser 1.0.0

Codex Browser 1.0.0 is the first routine-use release. It uses a visible, dedicated Microsoft Edge profile as the default browser runtime and keeps the Electron page runtime as an explicit troubleshooting fallback.

## Install And Start

The Windows x64 portable package requires:

- Windows with Microsoft Edge 109 or newer;
- Node.js 22.13.0 or newer;
- the Codex Browser personal plugin when browser tools are used from Codex.

Extract the package to a writable directory whose path may contain spaces or Chinese characters, then double-click `start-local.cmd`. The first launch creates a dedicated long-lived Edge profile in the current Windows user's local application-data area. It never reuses the user's ordinary Edge profile.

For the existing personal plugin installation, set `CODEX_BROWSER_PROJECT_ROOT` in its MCP configuration to the extracted package directory, then reload Codex. The validated development installation already points to `A:\Project\CodexBrowser` and needs no change when this directory remains the active installation.

## Security Boundaries

- Passwords, OTP values, Cookie values, authorization headers, signed URL query values, CDP endpoints, and profile paths are not returned to Codex.
- CAPTCHA, Turnstile, login, MFA, passkey, certificate, permission, and native file-selection steps remain visible user actions.
- Sending, publishing, deletion, purchase/payment, uploads, important account changes, permissions, and legal acceptance require a short-lived user confirmation.
- Confirmations are revision-bound and single-use. Non-idempotent operations are never replayed after a crash or uncertain connection loss.

## Data And Recovery

Edge manages persistent browser storage and passwords in the dedicated profile. The control center can clear current-site data, clear all browser data, or reset the dedicated profile after explicit user confirmation. Downloads and imported documents are managed separately.

To use the temporary legacy fallback:

```powershell
$env:CODEX_BROWSER_RUNTIME = "electron-legacy"
.\start-local.cmd
```

Remove the environment variable and restart to return to the default external Edge runtime.

## Verification

This release passed the full Phase 0 through Phase 7 deterministic suite, a 30-minute recovery run, a 60-minute endurance run, security-canary scanning with zero leaks, renderer Playwright acceptance, plugin validation, and a supervised read-only public-site matrix. Production dependency audit reported zero known vulnerabilities.

Known limits remain documented in `README.md`. Real authentication and native browser security flows are site/device dependent and user-operated.
