# Codex Long-Lived Browser Plan

Status: Proposed  
Date: 2026-07-16  
Target: A general-purpose, long-lived browser for Codex that behaves like a normal desktop browser and requests human help only when identity, anti-bot, browser-native, or high-risk steps require it.

## 1. Executive Decision

Build the next version around a visible, independent Edge or Chromium process with a dedicated persistent browser profile. Codex controls web content through a local policy broker that translates a limited MCP API into Chrome DevTools Protocol (CDP) operations.

Do not expose raw CDP to Codex. Do not fork Chromium. Do not implement a custom password manager. Do not continue expanding Electron `WebContentsView` into a complete browser product.

The target process topology is:

```text
Codex
  |
  | MCP: bounded, redacted browser operations
  v
Codex Browser Broker
  |- task scheduler and per-tab state machine
  |- action policy and confirmation gates
  |- snapshot and screenshot redaction
  |- challenge and authentication detector
  |- human-assistance coordinator
  |- download and document services
  `- CDP adapter
       |
       | private local transport
       v
Independent Edge/Chromium process
  |- visible native browser window
  |- dedicated persistent user-data directory
  |- browser-owned cookies, storage, cache, permissions, and passwords
  `- normal user takeover at any time
```

This produces a standalone browser experience while retaining the compatibility, security updates, password manager, and browser behavior of a maintained Chromium product.

## 2. Product Definition

### 2.1 Goals

- Remain available for long-running Codex tasks and recover cleanly after broker or browser restarts.
- Behave close to a normal interactive Edge/Chromium session: visible window, normal profile, native tabs, browser-managed downloads, permissions, passwords, and storage.
- Let Codex perform routine browsing without supervision.
- Pause only the affected tab when a human step is required; unrelated tabs should continue when policy allows.
- Preserve persistent cookies, local storage, SSO state, cache, and browser settings in a dedicated profile.
- Reliably detect Cloudflare, Turnstile, CAPTCHA, login, MFA, passkey, consent, permission, file-picker, certificate, and stalled-page situations.
- Verify that a human step actually succeeded before resuming automation.
- Prevent passwords, OTP values, cookies, authorization headers, signed URLs, private local paths, and raw browser-profile data from reaching Codex.
- Place irreversible or externally consequential actions behind explicit policy gates.
- Preserve the current PDF download, import, page reading, and search workflow.

### 2.2 Non-Goals

- Bypassing CAPTCHA, Cloudflare, bot defenses, paywalls, or access controls.
- Hiding automation through fingerprint spoofing or stealth patches.
- Building or maintaining a browser rendering engine.
- Forking Chromium or shipping a custom Chromium distribution in the first release.
- Reading, exporting, synchronizing, or managing saved passwords.
- Sharing the user's normal Edge profile with Codex.
- Guaranteeing unattended operation on sites that require repeated human verification.
- Automating payments, account deletion, message sending, publication, or other high-impact actions without an explicit policy decision.

## 3. Core Principles

1. Normal browser first: use a maintained browser product and its native profile semantics.
2. Dedicated identity boundary: never attach Codex to the user's everyday browser profile.
3. Least-capability control: Codex sees task-level browser tools, not the full CDP surface.
4. Per-tab interruption: one blocked tab must not freeze the entire browser.
5. Verify before resume: a user acknowledgement is evidence to re-check, not proof of success.
6. Browser-owned secrets: passwords and authentication secrets remain in the browser or OS credential store.
7. Redact at collection time: sensitive values should never enter snapshots, logs, task records, or MCP responses.
8. Visible and interruptible: all browser activity is visible and the user can pause or stop it immediately.
9. No anti-bot circumvention: challenge handling means human takeover, not automated solving.
10. Observable state: every action, block, confirmation, recovery, and failure has a sanitized audit record.

## 4. Browser Runtime Choice

### 4.1 Initial Runtime

Use the installed stable Microsoft Edge channel on Windows with:

- A dedicated user-data directory, separate from the user's normal Edge profile.
- A visible, non-headless browser window.
- A controlled startup configuration with the minimum required command-line flags.
- Browser updates handled by Edge rather than by this project.
- A transport abstraction that prefers a private CDP pipe and supports an ephemeral loopback port only as a documented fallback.

Proposed profile location:

```text
%LOCALAPPDATA%\CodexBrowser\profiles\primary
```

The exact location must be resolved through the OS application-data APIs and must not be exposed through MCP.

### 4.2 Startup Flags

Use only flags required for the dedicated profile and control transport. Avoid broad automation, certificate, sandbox, proxy, or security-disabling flags.

Conceptual startup configuration:

```text
msedge.exe
  --user-data-dir=<dedicated-profile>
  --no-first-run
  --no-default-browser-check
  <private CDP transport configuration>
```

Do not use:

- `--ignore-certificate-errors`
- `--disable-web-security`
- `--no-sandbox`
- a fixed remotely accessible debugging port
- the user's default Edge profile directory

### 4.3 Transport Selection

Preferred order:

1. CDP pipe owned by the broker process, if the selected Node CDP library and Edge version are reliable on Windows.
2. Ephemeral `127.0.0.1` debugging port discovered from the dedicated profile's `DevToolsActivePort` file.

The fallback port is not an authentication boundary. If it is used:

- Bind only to loopback.
- Choose a random port rather than a stable well-known port.
- Never return the port or browser WebSocket URL through MCP.
- Delete stale discovery files before startup only after verifying the target profile path.
- Terminate the endpoint when the managed browser exits.
- Document that same-machine processes may still discover and attack a raw CDP endpoint.

The broker is the security boundary for Codex, but OS-level isolation is still required for protection against other local processes.

### 4.4 Future Runtime Options

Support additional adapters only after the Edge path is stable:

- Installed Chrome stable channel.
- A pinned Chromium build for reproducible enterprise deployment.
- A managed CEF shell only if product requirements later demand full branding or custom native chrome.

A Chromium fork remains out of scope because it creates a continuous security patching and compatibility burden.

## 5. Proposed Components

The codebase should be separated into browser-independent orchestration and browser-specific adapters.

```text
src/
  broker/
    command-router.ts
    task-scheduler.ts
    policy-engine.ts
    assistance-coordinator.ts
    audit-service.ts
  browser/
    browser-runtime.ts
    edge-runtime.ts
    cdp-transport.ts
    cdp-browser-adapter.ts
    tab-registry.ts
    page-observer.ts
    challenge-detector.ts
    auth-verifier.ts
    download-adapter.ts
  security/
    snapshot-redactor.ts
    screenshot-redactor.ts
    url-redactor.ts
    secret-classifier.ts
    profile-boundary.ts
  electron/
    main.ts
    preload.ts
  renderer/
    main.tsx
  mcp/
    index.ts
  shared/
    contracts.ts
```

Electron may remain as the local control center for task status, assistance prompts, downloads, documents, and browser lifecycle. It should no longer render third-party webpages.

### 5.1 `BrowserRuntime`

Responsibilities:

- Find a supported browser executable.
- Validate the dedicated profile path.
- Start, attach to, monitor, and stop the browser process.
- Detect incompatible or already-locked profiles.
- Recover from a broker restart without starting a duplicate browser.
- Report browser version and CDP protocol compatibility.
- Distinguish graceful browser exit from crashes.

Required interface:

```ts
interface BrowserRuntime {
  start(): Promise<BrowserConnection>;
  attach(): Promise<BrowserConnection>;
  status(): Promise<BrowserRuntimeStatus>;
  show(): Promise<void>;
  shutdown(options: { graceful: boolean }): Promise<void>;
}
```

### 5.2 `CdpBrowserAdapter`

Responsibilities:

- Discover and track browser targets.
- Map CDP target IDs to stable public tab IDs.
- Navigate, observe, snapshot, act, wait, capture, and manage downloads.
- Reconnect sessions when a renderer process changes after navigation.
- Listen for target, frame, network, dialog, download, and lifecycle events.
- Hide CDP session IDs and target IDs from MCP clients.

The adapter must not provide a generic `cdp.send` escape hatch.

### 5.3 `PolicyEngine`

Every requested action receives one of four decisions:

| Decision | Meaning | Examples |
|---|---|---|
| `allow` | Execute without user involvement | navigation, scroll, ordinary search input |
| `allow_redacted` | Execute but suppress sensitive results | screenshots near forms, session health checks |
| `confirm` | Ask before executing | submit purchase, publish, send, delete, permission changes |
| `deny_manual` | Codex must not perform it | password/OTP entry, CAPTCHA, passkey, browser credential UI |

Policy inputs include action type, element classification, page origin, tab state, form context, destination, prior user authorization, and requested data exposure.

Policy decisions must be deterministic, logged without secrets, and unit tested independently of the browser.

## 6. Browser and Tab State Model

Use separate browser-level and tab-level state machines.

### 6.1 Browser States

```text
STOPPED -> STARTING -> CONNECTING -> READY
                         |           |
                         v           v
                       ERROR <-> RECOVERING
READY -> SHUTTING_DOWN -> STOPPED
```

### 6.2 Tab States

```text
READY
  -> RUNNING
  -> WAITING_PAGE
  -> READY

RUNNING or WAITING_PAGE
  -> WAITING_USER
  -> VERIFYING
  -> READY
       or WAITING_USER

Any active state
  -> PAUSED_BY_USER
  -> READY

Any active state
  -> ERROR
  -> READY after explicit recovery
```

Rules:

- `WAITING_USER`, `VERIFYING`, and `PAUSED_BY_USER` reject all mutating Codex actions for that tab.
- Observation remains available in redacted form unless a sensitive browser-native surface is active.
- New actions for a blocked tab remain queued or fail with a typed error according to the caller's requested behavior.
- Other tabs continue unless a browser-wide modal, profile lock, or global user pause exists.
- Closing a blocked tab requires user confirmation or an explicit force operation.
- Each transition records a sanitized reason and timestamp.

This corrects the current behavior where `waiting_user` changes presentation but does not itself enforce an automation freeze.

## 7. Cloudflare and Challenge Handling

### 7.1 Detection Model

Implement a scored detector rather than relying on one keyword. Signals are evaluated from the main frame, child frames, network traffic, response headers, URL, title, visible text, DOM, and progress history.

High-confidence signals:

- Main-frame or challenge-frame URL containing `/cdn-cgi/challenge-platform/`.
- Frame origin `https://challenges.cloudflare.com`.
- Turnstile iframe, `cf-turnstile` element, or known Turnstile script.
- Response header `cf-mitigated: challenge`.
- A recognized CAPTCHA provider iframe or widget.

Supporting signals:

- HTTP 403, 429, or 503 on the main frame.
- `cf-ray` response header.
- Titles such as `Just a moment...` or `Attention Required`.
- Text such as `Verify you are human`, `Checking your browser`, or localized equivalents.
- Repeated main-frame reloads without reaching expected content.
- A challenge page that remains visible beyond a short stabilization period.

Do not classify every 403 as Cloudflare. A 403 should still create an authorization or access prompt, but the displayed reason should remain generic unless Cloudflare-specific evidence exists.

### 7.2 Trigger Behavior

When the confidence threshold is reached:

1. Transition the affected tab to `WAITING_USER` atomically.
2. Cancel or suspend its queued mutating actions.
3. Record the pre-challenge URL, title, relevant response status, and a hash of the known Cookie names; never record Cookie values.
4. Bring the browser window and affected tab to the foreground.
5. Display a desktop assistance request with concise instructions.
6. Flash the task-center window or send one deduplicated OS notification.
7. Continue passive challenge observation without clicking or solving it.

### 7.3 Completion Verification

After the user reports completion, enter `VERIFYING` and require a combination of evidence:

- Known challenge frames and DOM markers are gone.
- Main-frame URL or content has advanced.
- The protected resource no longer returns the blocking status.
- A relevant Cookie-name set changed, where applicable.
- The page remains stable for a short verification window.

For Cloudflare, a changed `cf_clearance` value can be used internally as evidence, but its value must never be logged or returned. The presence of `cf_clearance` alone is not sufficient because it may be stale or scoped to another host.

If verification fails, return to `WAITING_USER` with the detected reason. Limit automatic verification retries and never create notification loops.

### 7.4 Challenge Policy

- Do not automatically click Turnstile or CAPTCHA controls.
- Do not use third-party solving services.
- Do not alter browser fingerprints to evade controls.
- Do not claim success merely because the challenge page disappeared; verify the intended resource.
- Treat site blocks and access-denied pages distinctly from solvable challenges.

## 8. Authentication and Human Assistance

### 8.1 Assistance Types

Retain and extend the current categories:

- `credential`
- `verification`
- `challenge`
- `passkey`
- `consent`
- `file_selection`
- `permission`
- `certificate`
- `high_risk_confirmation`
- `manual_action`

### 8.2 Assistance Request Contract

Each request includes:

- Stable assistance ID.
- Tab ID and sanitized origin.
- Type, title, and concise explanation.
- Creation and expiry timestamps.
- Verification strategy identifier.
- Status: `waiting_user`, `verifying`, `completed`, `unable`, `cancelled`, or `expired`.
- Optional sanitized user note.

Only one active assistance request may own a tab. A new request must explicitly replace, merge with, or queue behind the existing request.

### 8.3 User Experience

- Focus the exact browser tab requiring attention.
- Keep Codex activity visibly paused on that tab.
- Offer `Check and continue`, `Unable to complete`, and `Stop task`.
- Do not ask the user to paste passwords or OTP values into the controller UI.
- Do not show internal CDP, selector, Cookie, or profile details.
- Preserve the challenge page exactly as rendered by the browser.
- Let the user pause all Codex control at any time with an always-available control.

## 9. Password and Autofill Strategy

### 9.1 Ownership

The browser owns password saving and autofill. Codex Browser does not store credentials and does not expose a credential-management API.

The dedicated profile may use Edge's password manager according to the user's browser settings. Browser sync should be disabled by default for the dedicated Codex profile until its privacy implications are explicitly accepted.

### 9.2 Codex Restrictions

- Password, current-password, new-password, OTP, passkey, recovery-code, secret, and token fields are always sensitive.
- Codex cannot fill, read, select, copy, screenshot, or submit sensitive values.
- A browser-autofilled password remains sensitive even if the DOM exposes its value.
- Login submit controls inside a sensitive form require manual action by default.
- Username and email fields may be automated only when they are not part of a sensitive challenge and policy permits it.
- Saved-password prompts and browser-native credential UI remain manual.

### 9.3 Collection-Time Redaction

Fix the current snapshot naming fallback before enabling external-browser control. A sensitive input's accessible name must never fall back to its `value`.

For every sensitive element:

- Return a fixed label such as `Sensitive input` if no safe accessible label exists.
- Omit `value`, selection, form serialization, and surrounding autofill metadata.
- Cover it in viewport and element screenshots.
- Redact relevant console, accessibility-tree, DOM attribute, and network payload fields.
- Prevent task errors from echoing page-provided secret values.

Add tests using unlabeled password fields, dynamically changed input types, shadow DOM, iframes, contenteditable login widgets, and browser autofill.

## 10. Cookie, Storage, and Profile Policy

### 10.1 Default Behavior

- Use one dedicated persistent profile named `primary` for the first release.
- Let Edge/Chromium own persistent Cookie, IndexedDB, local storage, cache, service workers, and site permission persistence.
- Share the profile across tabs, matching a normal browser product.
- Never use the user's default Edge profile.
- Keep the browser running when the task-center window is closed, subject to a user setting.
- Close the browser gracefully during an intentional full exit.

### 10.2 Session Cookies

Normal browser semantics should be the default. Do not silently convert all session cookies into permanent cookies.

For controlled restart recovery, an optional encrypted session-recovery feature may preserve session cookies with these constraints:

- Encrypt through Windows user-bound storage.
- Store only the fields necessary for restoration.
- Apply a short configurable recovery lifetime.
- Record domain and Cookie name only in diagnostics, never values.
- Delete expired recovery data.
- Expose a user-facing setting and clear-data operation.
- Do not restore after the user explicitly chooses a clean exit or clears site data.

The current encrypted backup can be migrated into this policy, but it must no longer report every successful authentication as permanently saved without distinguishing persistent and recovered session cookies.

### 10.3 Cookie Exposure

Codex may receive only aggregate session information:

- Cookie count.
- Whether relevant Cookie names changed.
- Whether a protected resource can be accessed.
- Whether encrypted recovery is available.

Codex must never receive raw Cookie values, `Set-Cookie`, `Cookie`, authorization headers, CDP network extra-info payloads, or browser cookie-database files.

### 10.4 Data Controls

Provide browser-product-level controls:

- Clear data for the current site.
- Clear all Codex Browser browsing data.
- Clear downloads and document index independently.
- Reset the dedicated profile after explicit confirmation.
- Show storage categories and approximate sizes without exposing secrets.
- Export only non-sensitive task/document metadata.

## 11. Browser-Native UI and Permissions

CDP controls webpages well but does not reliably control every native browser surface. Treat these as explicit integration cases:

- File and directory pickers.
- Download location prompts.
- Camera, microphone, geolocation, clipboard, notification, and MIDI permissions.
- Certificate errors and client-certificate selection.
- HTTP authentication dialogs.
- Password-save and passkey dialogs.
- Print dialogs and external-protocol prompts.
- Browser update, crash, restore, and profile-lock UI.

Default policy:

- Deny unexpected permissions automatically when safe.
- Request user assistance for permissions required by the task.
- Never bypass certificate errors automatically.
- Use controlled file paths only after an explicit file-selection grant.
- Prefer browser-configured automatic download behavior over OS UI automation.
- Use Windows UI Automation only for narrowly scoped, well-tested native flows; it must not become the general browser control plane.

## 12. MCP Surface

Keep the MCP API task-oriented and browser-independent.

### 12.1 Core Tools

- `browser_capabilities`
- `browser_status`
- `browser_start`
- `browser_show`
- `browser_pause`
- `browser_resume`
- `browser_stop`
- `browser_tabs`
- `browser_tab_create`
- `browser_tab_select`
- `browser_tab_close`
- `browser_navigate`
- `browser_observe`
- `browser_snapshot`
- `browser_screenshot`
- `browser_act`
- `browser_wait`
- `browser_back`
- `browser_forward`
- `browser_reload`
- `browser_dialogs`
- `browser_dialog_respond`

### 12.2 Assistance and Session Tools

- `browser_request_assistance`
- `browser_assistance_status`
- `browser_assistance_complete`
- `session_check`
- `auth_request_login`
- `auth_complete`

### 12.3 Document Tools

Retain the current paper discovery, download, import, list, read, and search tools. Download URLs remain opaque and signed query strings remain inside the broker.

### 12.4 Contract Rules

- Every mutating command accepts an optional tab ID and expected snapshot revision.
- Every response includes the stable tab ID and sanitized state transition.
- Stale snapshots fail rather than acting on a changed page.
- Blocked actions return typed errors such as `USER_ACTION_REQUIRED`, `TAB_WAITING_USER`, `CONFIRMATION_REQUIRED`, `PAUSED_BY_USER`, and `STALE_SNAPSHOT`.
- No tool accepts arbitrary JavaScript, arbitrary CDP methods, raw headers, or raw Cookie data.
- Tool descriptions explicitly state sensitive-action restrictions.

## 13. Task Scheduling and Concurrency

- Serialize mutating actions per tab.
- Allow parallel work across independent tabs with a configurable global limit.
- Keep observations and status reads outside the mutating queue when they are safe.
- Attach every action to a task ID, tab ID, generation, and snapshot revision.
- Cancel queued actions when the user stops a task or a tab enters `WAITING_USER`.
- Abort network probes and waits when their generation becomes stale.
- Prevent late events from completing cancelled tasks.
- Rate-limit rapid navigation and interaction loops.
- Add an idle watchdog that distinguishes slow pages from challenge loops.

## 14. Observability and Audit

Maintain a local sanitized event log containing:

- Browser start, attach, version, disconnect, crash, and recovery.
- Tab creation, closure, navigation origin, and state transitions.
- Requested action type and policy decision.
- Assistance creation, verification, completion, cancellation, and expiry.
- Download and document lifecycle.
- Redaction and blocked-exposure counters.

Never log:

- Passwords, OTPs, recovery codes, passkeys, tokens, or secrets.
- Cookie values or authorization headers.
- Request or response bodies by default.
- Signed URL query strings.
- Full local paths through MCP-visible logs.
- Raw DOM or screenshots from authentication pages.
- Raw browser profile contents.

Use structured logs with retention limits and a user-facing clear operation. Crash reports must pass through the same redaction layer.

## 15. Recovery and Lifecycle

### 15.1 Broker Restart

- Detect the managed browser through a profile-scoped ownership record.
- Validate process identity and executable path before attaching.
- Rebuild the target registry from current CDP targets.
- Mark interrupted mutating actions as failed or queued according to idempotency.
- Restore only sanitized task metadata.
- Re-detect authentication and challenge state for every restored tab.

### 15.2 Browser Crash

- Record a sanitized crash event.
- Restart once automatically when policy permits.
- Reopen the dedicated profile using normal browser restore behavior.
- Do not automatically replay non-idempotent actions.
- Reconnect tabs and require fresh snapshots.
- Escalate repeated crash loops to the user.

### 15.3 Full Exit

- Stop accepting new mutating commands.
- Drain or cancel task queues.
- Flush runtime metadata and document indexes.
- Ask Edge/Chromium to close gracefully.
- Wait for profile locks to release.
- Apply the configured session-recovery policy.
- Leave no fixed CDP listener behind.

## 16. Migration Plan

### Phase 0: Security and Contract Baseline

Objective: make current behavior explicit and close known sensitive-data gaps before changing runtimes.

Work:

- Add tests proving passwords cannot appear in snapshot names, values, screenshots, errors, or logs.
- Make `waiting_user` enforce a per-tab mutation freeze.
- Define typed browser runtime, tab state, assistance, and policy contracts.
- Add a browser-independent adapter interface around current `WebContentsView` operations.
- Capture a compatibility baseline for current MCP tools and PDF workflows.

Exit criteria:

- Sensitive-field regression suite passes.
- Every current command is mapped to the adapter interface.
- No functional path calls Electron web contents directly outside the legacy adapter.

### Phase 1: External Browser Runtime Prototype

Status: Completed on 2026-07-17 with the isolated Edge prototype smoke.

Objective: start and control an independent Edge instance without changing the public MCP contract.

Work:

- Implement Edge executable discovery and version reporting.
- Create and validate the dedicated profile directory.
- Implement preferred private CDP transport and loopback fallback.
- Start, attach, show, monitor, and gracefully stop Edge.
- Discover tabs and map target IDs to stable internal IDs.
- Add an isolated test profile fixture; never use the normal profile in tests.

Exit criteria:

- A visible Edge window starts with the dedicated profile.
- Broker restart can reconnect without creating a duplicate browser.
- Browser exit removes the debugging endpoint.
- Version mismatch produces a clear non-destructive error.

### Phase 2: Core Browsing Parity

Status: Completed on 2026-07-17 with the isolated Edge core browsing smoke.

Objective: reproduce the existing interaction surface through CDP.

Work:

- Implement navigation, history, reload, tab management, snapshots, screenshots, actions, and waits.
- Recreate trusted pointer and keyboard input through CDP input domains.
- Support cross-frame observation without crossing origin boundaries through unsafe page injection.
- Implement stale-snapshot revisions across navigation and DOM replacement.
- Reconnect CDP sessions after renderer swaps.
- Port download observation and PDF capture.

Exit criteria:

- Existing MCP, action, runtime, download, and document smoke tests pass against the external adapter.
- Normal actions work across top-level pages, same-origin frames, cross-origin frames, popups, and renderer-process changes.
- No raw CDP identifier reaches MCP output.

### Phase 3: Assistance and Challenge System

Objective: safely minimize human involvement while reliably stopping when it is required.

Work:

- Implement the per-tab state machine and queue enforcement.
- Implement scored Cloudflare, Turnstile, CAPTCHA, login, MFA, passkey, permission, and certificate detection.
- Add challenge verification strategies and protected-resource probes.
- Add deduplicated notification, expiry, replacement, and recovery behavior.
- Focus the exact browser tab during assistance.

Exit criteria:

- Local fixtures cover positive and negative detections.
- A 403 without Cloudflare evidence is not mislabeled as Cloudflare.
- A Turnstile fixture freezes only its own tab.
- User completion cannot resume the task until verification passes.
- Repeated challenge observations do not create notification storms.

### Phase 4: Normal-Browser Data Behavior

Objective: make profile, Cookie, password, permission, and clearing behavior understandable and durable.

Work:

- Document profile ownership and browser-managed password behavior.
- Implement storage summary and clear-current-site/all-data controls.
- Implement optional time-limited encrypted session recovery.
- Add profile reset and profile-lock recovery.
- Verify persistent cookies, session-cookie semantics, local storage, IndexedDB, service workers, and browser restart behavior.

Exit criteria:

- Persistent site login survives a normal restart when the site intended it to.
- Explicit data clearing removes the selected data and recovery backup.
- Password values never enter Codex Browser storage or telemetry.
- The user's default Edge profile remains untouched.

### Phase 5: Safety Policy and High-Risk Actions

Objective: make long unattended sessions safe enough for general browsing.

Work:

- Implement the four-way policy decision model.
- Classify login submission, communication, publication, financial, destructive, permission, and external-protocol actions.
- Add confirmation requests with origin, action, and effect summaries.
- Add remembered grants with narrow origin, action, and time scopes.
- Add audit views and revoke controls.

Exit criteria:

- Destructive and externally consequential fixtures cannot execute silently.
- Grants cannot expand to another origin or action class.
- Policy decisions are deterministic and fully covered by unit tests.

### Phase 6: Cutover and Legacy Removal

Objective: make external Edge the default while retaining a controlled rollback path.

Work:

- Run both adapters behind a development-only feature flag.
- Compare behavior, performance, and failure rates using sanitized diagnostics.
- Migrate non-sensitive runtime metadata; do not copy raw Chromium profile files between engines.
- Make external Edge the default.
- Keep the Electron adapter for one release as a fallback, then remove it after acceptance.
- Update the personal Codex plugin, validate it, and document the new runtime requirements.

Exit criteria:

- Full verification passes with the external runtime at both supported desktop sizes.
- A clean machine setup succeeds without manual profile surgery.
- Upgrade and rollback procedures are documented and tested.
- The personal plugin validates and all public tools report the new runtime accurately.

Implementation note: Phase 6 retains the legacy adapter as the documented `electron-legacy` rollback path. Removal is deferred until a separate real-world acceptance decision; it is not required for this cutover.

### Phase 7: Real-Use Acceptance, Hardening, And Release

Objective: prove that the Phase 6 external-Edge default is suitable for routine use, fix only reproducible release blockers, and finish delivery without adding a browser engine, challenge bypass, password manager, automation framework, or architectural redesign.

Work:

- Run the complete Phase 0 through Phase 6 regression matrix for both the external-Edge default and explicit legacy fallback.
- Add a repeatable 60-minute isolated endurance smoke with multi-tab browsing, snapshots, trusted actions, iframe, popup, screenshots, downloads, PDF import, blocked-tab concurrency, reconnect, browser recovery, and resource sampling.
- Add deterministic synthetic-secret canaries that fail if credentials, Cookie/auth material, signed queries, transport endpoints, profile paths, payment data, or message bodies reach MCP or broker logs.
- Perform a low-frequency, read-only public-site matrix with a temporary profile; never use real credentials, consequential actions, scraping, or challenge bypass.
- Verify installation, version/schema compatibility, profile ownership and lock recovery, Unicode/space paths, malformed metadata, upgrade invalidation, UI states, plugin packaging, rollback, cleanup, and troubleshooting guidance.

Exit criteria:

- All deterministic automated tests, the 60-minute endurance run, security canaries, renderer QA, and plugin source validation pass.
- No duplicate managed Edge, leaked profile lock, unbounded CDP sessions, replayed high-risk action, or synthetic secret is observed.
- Public-site limitations and any environment-blocked plugin reinstall are recorded without weakening local deterministic acceptance.
- README, release checklist, plan, and worklogs state an evidence-based release recommendation and retain `electron-legacy` as the controlled rollback.

## 17. Verification Strategy

### 17.1 Unit Tests

- Policy decisions and risk classification.
- URL, header, text, snapshot, screenshot, and log redaction.
- Challenge scoring with positive and negative fixtures.
- State-machine transitions and invalid transition rejection.
- Assistance replacement, expiry, verification, and recovery.
- Profile path boundaries and ownership validation.
- CDP event normalization and public ID mapping.

### 17.2 Integration Tests

- Browser start, attach, reconnect, crash, and shutdown.
- Persistent profile and profile-lock behavior.
- Multi-tab concurrency with one blocked tab.
- Cross-origin frames, popups, downloads, dialogs, and renderer swaps.
- Cookie persistence, explicit clearing, and optional recovery.
- Autofilled password fields with zero secret exposure.
- Protected-resource probes with redirects and HTML login responses.

### 17.3 Challenge Fixtures

Maintain deterministic local fixtures representing:

- Cloudflare-like 403 and 503 pages.
- Cloudflare-like 200 challenge pages.
- Turnstile frames and localized human-verification text.
- Ordinary 403 access denied without Cloudflare.
- Login, MFA, OTP, passkey, and CAPTCHA forms.
- Repeated refresh loops and legitimately slow pages.
- Challenge success, stale Cookie, failure, and timeout.

Fixtures test detection and state handling only; they do not attempt to emulate or defeat real Cloudflare security.

### 17.4 End-to-End Checks

Required after implementation changes:

```text
npm run typecheck
npm run build
npm run smoke:mcp
npm run smoke:actions
npm run smoke:runtime
npm run smoke:advanced
```

Add an external-browser smoke suite that uses a temporary dedicated profile and guarantees cleanup. Renderer changes require Playwright screenshots under `output/playwright/` at the minimum and standard window sizes. Plugin changes require personal plugin validation after the cachebuster/reinstall workflow.

Never run automated tests against the user's real dedicated profile.

## 18. Acceptance Criteria

The external-browser version is ready for long-term daily use when all of the following are true:

- The browser is a visible independent Edge/Chromium window using a dedicated persistent profile.
- Codex can perform normal navigation, observation, interaction, downloads, and document workflows without supervision.
- Browser and broker restarts preserve intended browser state and do not duplicate processes.
- One blocked tab does not stop unrelated tabs.
- Cloudflare/Turnstile fixtures reliably enter verified human takeover without automated solving.
- Login, MFA, passkey, password, certificate, and native permission boundaries are enforced.
- No sensitive field value, Cookie value, authorization header, signed query, or raw profile data reaches MCP or logs.
- High-risk actions are denied or confirmed according to policy.
- Users can pause globally, stop tasks, clear site data, clear all browser data, and reset the profile.
- The browser control transport is private to the local runtime and never intentionally exposed to the network.
- All required static, build, smoke, browser, recovery, and plugin checks pass.

## 19. Key Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Raw CDP access compromises logged-in sites | Critical | Private transport, no MCP passthrough, dedicated profile, bounded broker API |
| Autofilled password leaks through DOM or accessibility data | Critical | Collection-time classification and redaction, manual sensitive forms, regression fixtures |
| False negative challenge detection | High | Multi-signal scoring, network/frame signals, stalled-loop detector, user pause control |
| False positive freezes normal pages | Medium | Confidence thresholds, generic 403 handling, visible reason, quick user recovery |
| Browser update changes CDP behavior | High | Version probe, compatibility tests, adapter isolation, clear unsupported-version state |
| Profile corruption or lock | High | Single owner, graceful close, ownership record, backup/reset controls, no file-level copying |
| Replayed non-idempotent action after recovery | High | Generation IDs, action classification, never replay high-risk actions automatically |
| Local process discovers fallback CDP port | High | Prefer pipe, ephemeral loopback fallback, dedicated OS user boundary documentation |
| Site policy rejects automation | Medium | No stealth claims, visible browser, human takeover, respect blocks and site terms |
| Session recovery extends site sessions unexpectedly | Medium | Normal semantics by default, optional TTL-bound encrypted recovery, explicit clear controls |

## 20. Default Decisions Requiring Confirmation During Implementation

Proceed with these defaults unless testing establishes a concrete blocker:

- Runtime: installed stable Edge.
- Profile: one dedicated local profile named `primary`.
- Browser mode: visible and user-interruptible at all times.
- Transport: CDP pipe preferred; ephemeral loopback fallback.
- Passwords: Edge-owned, sync disabled by default, never exposed to Codex.
- Session recovery: normal browser semantics first; encrypted short-lived recovery opt-in.
- Challenge policy: detect, freeze, request human assistance, verify; never solve automatically.
- High-risk actions: explicit confirmation with narrow temporary grants.
- UI: Electron remains the task and assistance center, not the webpage host.
- Migration: adapter-based incremental replacement with one-release fallback.

## 21. First Implementation Slice

The first implementation session should remain deliberately narrow:

1. Fix the sensitive-input accessible-name leak and add regression tests.
2. Add browser-independent `BrowserAdapter` and tab-state contracts.
3. Make `WAITING_USER` reject mutating actions on the affected tab.
4. Implement Edge discovery and a temporary-profile launch/stop prototype.
5. Prove CDP connection, tab discovery, navigation, and graceful shutdown without changing the current default runtime.
6. Record the chosen CDP transport and measured Edge compatibility before porting further actions.

This slice reduces current risk, validates the central architectural assumption, and preserves a working browser throughout the migration.

## 22. Implementation Progress

### 2026-07-16 - Phase 0 (paused, final fixes pending)

- Added the browser/tab state types, complete command policy, per-tab generation controller, browser-independent adapter contract, and current Electron adapter implementation.
- Enforced tab-scoped `WAITING_USER`/`VERIFYING` mutation rejection with `TAB_WAITING_USER`, per-tab queues, cross-tab independence, and global stop cancellation.
- Added collection-time sensitive-field redaction across snapshots, observations, actions, screenshots, desktop/MCP state, errors, tasks, persistence inputs, and logs, including iframe/shadow traversal, autofill, dynamic reclassification, and mandatory screenshot masking.
- Removed renderer collection of assistance notes and sensitive prompt text; compatible MCP note input is ignored and caller-provided element refs are not retained in task records.
- Migrated all smoke scripts to unique named pipes, temporary profiles, owned Electron processes, random fixture ports, and verified cleanup so they cannot attach to the normal browser session.
- Added sensitive-field, tab-policy, redaction, persistence, and state-policy regression suites. Typecheck and unit suites pass; the sensitive suite has passed independently on the combined implementation checkpoint.
- Phase 0 is not complete: sensitive native-dialog verification, tab/origin-scoped authentication evidence, blocked-state restart recovery, the final full smoke chain, and renderer Playwright verification remain pending.
- No Phase 1 Edge launch, CDP transport, external profile, normal Edge profile use, or default-runtime change has been implemented.

### 2026-07-17 - Phase 0 implementation completed, final acceptance deferred

- Completed the browser-independent adapter call boundary, explicit browser/tab state contracts, tab-scoped mutation freeze, stop generations, blocked-state recovery metadata, and target-tab authentication evidence.
- Completed collection-time sensitive-field classification plus snapshot, observation, screenshot, error, task, persistence, log, download, and MCP redaction coverage.
- Fixed managed `beforeunload` handling for close and navigation intents without exposing raw CDP, JavaScript execution, Cookie, password, or authorization capabilities.
- Confirmed typecheck, build, adapter/auth-evidence/tab-policy/persistence/redaction tests, and the advanced isolated smoke on the final dialog implementation.
- The remaining full smoke chain and two-viewport Playwright acceptance pass were deferred when the user requested an immediate stop after code completion; Phase 0 is not marked accepted until those commands are rerun together.
- No Phase 1 implementation was started.

### 2026-07-17 - Phase 1 external Edge runtime prototype completed

- Added Windows Edge discovery with `CODEX_BROWSER_EDGE_PATH` override, executable validation, file-version reporting, and a clear non-download failure path.
- Added a managed runtime contract and Edge implementation covering `start`, `attach`, `status`, `show`, and graceful `shutdown`, while leaving Electron as the default runtime.
- Added unique `.runtime/edge-profiles/phase1-*` profiles, an exclusive project lock, duplicate-start rejection, bounded cleanup, and checks that no normal Edge profile is read or copied.
- Selected an ephemeral loopback CDP WebSocket transport discovered through `DevToolsActivePort`; no port, WebSocket URL, target ID, or session ID is returned through MCP.
- Added minimal page-target discovery, internal tab ID mapping, local-fixture tab creation/navigation/title and URL reads, tab close, control disconnect/reconnect, and rediscovery without starting a second Edge process.
- Verified Microsoft Edge 150.0.4078.65 on Windows with the Phase 1 smoke. The smoke confirmed graceful process exit, debugging-endpoint removal, profile-lock release, and bounded profile cleanup.
- Passed `npm run typecheck`, `npm run build`, `npm run smoke:mcp`, `npm run smoke:runtime`, `npm run smoke:advanced`, `npm run smoke:actions`, `npm run smoke:edge`, and `npm audit --omit=dev` with no production vulnerabilities.
- Phase 1 stops at the minimum runtime and tab lifecycle prototype. Snapshots, actions, frames, screenshots, downloads, PDF, challenge/login detection, Cookie handling, and password handling remain Phase 2 or later.

### 2026-07-17 - Phase 2 external Edge core browsing completed

- Added a full Edge `BrowserAdapter` behind `CODEX_BROWSER_RUNTIME=edge-prototype` and a private Edge broker using the existing named-pipe MCP boundary; Electron remains the default runtime.
- Added stable internal tab IDs, popup opener tracking, manual tab discovery, navigation/history/reload/stop, operation generations, reconnect recovery, and revision-bound stale reference rejection.
- Added bounded main-frame and one-level iframe observation/snapshots, collection-time sensitive value suppression, trusted CDP input actions, waits with timeout/cancellation, ordinary dialogs, and viewport/element screenshots with mandatory sensitive masking.
- Added managed download candidates, signed-query redaction, task/tab association, cancellation, PDF signature validation, visible PDF capture, and `DocumentService` import/list/read/search integration.
- Kept the Phase 1 ephemeral loopback WebSocket transport discovered through `DevToolsActivePort`; raw ports, WebSocket URLs, target IDs, and session IDs remain internal.
- Verified Microsoft Edge 150.0.4078.65. The local Edge 150 environment returns empty synthetic `204` bodies for loopback `Network.loadNetworkResource` and loopback PDF viewer interception, so the isolated smoke uses a path-validated loopback-only stream fallback; non-loopback resources do not receive that fallback.
- Added `smoke:edge-core` covering tabs, both popup forms, navigation, stale revisions, trusted actions, same/cross-origin frames, dialogs and sensitive prompts, screenshot redaction, waits/cancellation, signed URL redaction, download completion/cancellation, visible PDF, document import, stop generations, and reconnect invalidation.
- Passed `npm run typecheck`, `npm run build`, `npm run smoke:mcp`, `npm run smoke:actions`, `npm run smoke:runtime`, `npm run smoke:advanced`, `npm run smoke:edge`, `npm run smoke:edge-core`, and `npm audit --omit=dev` with 0 production vulnerabilities.
- Phase 2 is complete. Challenge/login detection, durable assistance workflows, complex nested frames, and special shadow DOM compatibility remain Phase 3 or later and were not started.

### 2026-07-17 - Phase 3 challenge detection and human takeover completed

- Added a browser-independent scored `ChallengeDetector` with centralized thresholds and sanitized signal types for Cloudflare 403/200 challenges, Turnstile, reCAPTCHA, hCaptcha, login/password, MFA, OTP, passkey/WebAuthn, and protected 401/403 resources.
- Added false-positive protections so an ordinary 403 is not classified as Cloudflare, an ordinary checkbox is not CAPTCHA, discussion text is not treated as a sensitive form, slow pages alone do not freeze, and mixed action fixtures containing a password field do not become whole-page login boundaries.
- Formalized `CLOSED` and typed `TAB_VERIFYING`/`TAB_CLOSED` states. Entering a human boundary invalidates prior generations and refs, rejects tab mutations atomically, and leaves unrelated tabs operational.
- Added the shared assistance coordinator with one active request per tab, deduplication, priority upgrades, expiry, stale-ID errors, verification retry, resolution, and global stop cancellation.
- Added verifier-driven resume: user completion requires explicit `userConfirmed=true`, fresh page evidence, disappearance of challenge/auth signals, a material page change, and a bounded protected-resource probe when required. Failed checks return to `WAITING_USER`; old actions are never replayed.
- Hardened the Edge protected-resource probe to use same-session HEAD with a bounded GET/Range fallback, manual redirects, timeout, HTML-login rejection, challenge status classification, and refusal to replay signed URLs.
- Added an Edge Electron control center that talks only to the private broker pipe, focuses once per assistance, emits one system notification, and exposes check/continue, unable, and stop without CDP or credential fields.
- Updated the renderer for waiting, verifying, completed, unable, and expired assistance states. Playwright passed at 1280x800 and 760x520 with no console errors or warnings; screenshots are under `output/playwright/`.
- Added detector/coordinator unit tests and `smoke:challenge`, covering tab freeze, cross-tab independence, stale actions, explicit confirmation, failed verification, verified resume, notification deduplication, stop cancellation, sensitive-output checks, and managed Edge/control-center cleanup.
- Passed typecheck, build, default Electron MCP/actions/runtime/advanced smokes, tab-policy and restart recovery smokes, Phase 1 Edge smoke, Phase 2 Edge core smoke, Phase 3 challenge smoke, adapter/challenge/state/persistence tests, and `npm audit --omit=dev` with 0 vulnerabilities on Microsoft Edge 150.0.4078.65.
- Updated and validated personal plugin cachebuster `0.1.0+codex.20260717061603`. CLI reinstall remains blocked by WindowsApps `codex.exe` access denial; the Codex app must reload the validated local plugin before a new task uses the updated wording.
- Phase 3 is complete. Phase 4 Cookie/data management and Phase 5 general high-risk policy were not started.

### 2026-07-17 - Phase 4 browser data and profile productization completed

- Defined a Codex Browser-owned long-lived Edge `primary` profile below Windows local application data, with strict path boundaries, ownership metadata, an exclusive lock, graceful release, and controlled archive/reset behavior. Temporary smoke profiles remain isolated under `.runtime` and are removed after verification.
- Kept normal Edge storage semantics as the default for persistent/session Cookie, Local Storage, IndexedDB, Cache Storage, service workers, HTTP cache, settings, password saving, and autofill. No Chromium Cookie or password database is parsed or copied.
- Added browser-independent storage summary and profile status contracts plus read-only `browser_storage_summary` and `browser_profile_status` MCP tools. Only aggregate counts, approximate sizes, safe status, and timestamps are exposed.
- Made Electron session recovery opt-in, Windows-user encrypted, profile-bound, TTL-limited, and fail-closed for expiry, mismatched profiles, legacy/corrupt data, disabled recovery, and explicit clearing. External Edge keeps custom recovery disabled.
- Added action-scoped, one-time, 60-second confirmation records for current-site clearing, all-data clearing, and dedicated-profile reset. Destructive operations are available only through the Electron control center/private broker boundary, not as direct MCP tools.
- Added current-site and all-data clearing for managed browser storage, revision invalidation after clearing, session-health refresh, and safe profile reset with old-profile archival. Downloads, imported PDFs, document indexes, and worklogs remain independent.
- Confirmed that autofill-like current/new password, OTP, dynamic password, unlabeled password, iframe password, and login-submit fixtures never expose sensitive values through snapshots or screenshots.
- Added the browser-data renderer with aggregate summary, explicit confirmation sheets, progress/success/error states, session-recovery explanation, and separate download/document wording. Playwright artifacts are stored under `output/playwright/`.
- Verified Microsoft Edge 150.0.4078.65. Its CDP Storage and Network clearing commands require a page session. Origin-scoped permission reset is not reliable in this version, so site-only permission clearing is disabled instead of issuing a global reset; all-data clearing resets permissions.
- Phase 4 is complete. Phase 5 high-risk action authorization and Phase 6 default-runtime cutover were not started.

### 2026-07-17 - Phase 5 high-risk policy and confirmation completed

- Added deterministic `allow`, `allow_redacted`, `confirm`, and `deny_manual` policy decisions using action, element, form, page, origin, tab, assistance, confirmation, and grant context.
- Added one-time confirmation requests with origin/revision/ref/category binding, approval-time revalidation, strict single consumption, stale/expiry rejection, and no retry after uncertain non-idempotent outcomes.
- Added short-lived origin/category/profile grants with revocation and explicit exclusions for payment, account security, credentials, CAPTCHA, passkeys, file selection, and legal acceptance.
- Added sanitized audit events and renderer confirmation/grant/audit views. MCP can inspect status and deny, but cannot approve.
- Added unit fixtures and `smoke:policy`; final Phase 6 regression also fixed ordinary username and out-of-form button false positives without weakening sensitive-submit protection.
- Phase 5 is complete. Phase 6 may proceed without changing these safety boundaries.

### 2026-07-17 - Phase 6 external Edge default cutover completed

- Formalized `external-edge` and `electron-legacy`; unset configuration now selects external Edge. Deprecated aliases remain temporarily accepted with migration notices, and Edge startup failure never silently falls back.
- Added safe persisted runtime settings, automatic broker/Edge startup and reuse, first-run/runtime/error UI, show/restart/stop controls, and updated local launch scripts.
- Strengthened owned profile lifecycle, same-Edge CDP reattach, bounded recovery after an owned Edge exit, old-ref invalidation, high-risk `outcome_unknown`, and conservative lock recovery.
- Kept the dedicated long-lived Edge profile isolated from Electron and ordinary Edge data. Legacy remains an explicit troubleshooting fallback with separate login state.
- Added runtime-selection tests, default-runtime smoke, and 30-minute stability verification; updated renderer Playwright artifacts, personal plugin, README, troubleshooting, and rollback documentation.
- Microsoft Edge 150.0.4078.65 is compatible with the ephemeral loopback WebSocket CDP transport. No endpoint, profile path, Cookie value, password, authorization data, or signed query secret is exposed.
- Phase 6 is complete. Legacy adapter removal is deferred to a separate acceptance decision and no later phase work was started.

### 2026-07-18 - Phase 7 real-use acceptance and release completed

- Added a release checklist, isolated 60-minute endurance harness, public-site acceptance harness, deterministic security canary scan, centralized release/version metadata, and version/profile compatibility tests.
- Fixed trusted Edge 150 scroll/keyboard/select focus, multi-tab session-local execution-context routing, legacy Electron screenshot fallback, and additional recovery-code/payment/path/endpoint redaction found during acceptance.
- Renderer acceptance artifacts cover first run, normal/high-DPI, assistance/verifying, runtime error, outcome unknown, storage/reset, legacy, long Chinese text, and minimum/standard layouts with zero observed console errors.
- Hardened Windows PowerShell 5 profile ownership discovery, managed Edge background shutdown, persisted broker ownership recovery, all-data cache clearing order, and stability recovery without replaying uncertain click operations.
- The formal 60-minute endurance run passed 1,057 iterations with 17 broker reconnects, 8 owned-browser recoveries, 36 popups, 53 screenshots, 24 downloads, 12 PDF imports, and no sustained resource growth or session accumulation. The separate 30-minute stability run passed owned-Edge replacement with zero transient recoveries on the final run.
- The security canary scanned 12 synthetic secrets across 15 MCP payloads, broker logs, and artifact directories with zero leaks. The supervised public-site matrix accepted 10 categories, including login/challenge human boundaries and a controlled public PDF download/import, without credentials or consequential actions.
- Default `external-edge`, explicit `electron-legacy`, Phase 1 through Phase 6 smokes, clean `npm ci` build, production audit, renderer artifacts, plugin validators, and live plugin status/tab/snapshot/document calls passed. Microsoft Edge 150.0.4078.65 is the verified release browser.
- Phase 7 is complete and version 1.0.0 is recommended for routine daily use. Real MFA, passkey, certificate, permission, and native file-picker completion remains user-operated and site/device dependent; local fixtures verify the safety and coordination boundary. No Phase 8 or new feature phase was started.
