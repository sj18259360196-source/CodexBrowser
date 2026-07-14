# Security Policy

## Supported Versions

Codex Browser is early alpha software. Security fixes are applied to the latest published `0.1.x` release and the current `main` branch.

## Report A Vulnerability

Do not open a public issue for a suspected vulnerability. Use the repository's [private security advisory form](https://github.com/sj18259360196-source/CodexBrowser/security/advisories/new).

Include the affected version or commit, reproduction steps, expected impact, and any relevant sanitized logs. Never include passwords, MFA codes, cookies, authorization headers, private browser-profile files, or signed URLs in a report.

## Scope

Security-sensitive areas include:

- MCP tool authorization and sensitive-field blocking.
- Cookie, credential, session, and browser-profile storage.
- Named-pipe access and local process boundaries.
- Download, document import, and path handling.
- Browser-skill import, learning, validation, and execution.
- Screenshot and page-data redaction.

Reports about bypassing third-party paywalls, DRM, captchas, institutional access controls, or account restrictions are outside the project's intended behavior.
