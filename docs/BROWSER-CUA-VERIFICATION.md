# Browser and CUA verification

Packaged-app baseline: 2026-08-21 on Apple Silicon macOS. Unreleased source
checks are recorded separately below.

## Unreleased runtime fixes — 2026-09-07

- `browser.run` now evaluates page JavaScript with top-level `await` support.
  The final expression is returned; ordinary Promise results are awaited too.
  Code is evaluated only once, including when it throws a runtime SyntaxError.
  Page-context execution does not expose Node.js or Puppeteer variables.
- The existing 64 KiB code, 256 KiB result and time limits remain. Temporary
  remote objects are released, closing a session still interrupts pending
  scripts, and the evaluator explicitly does not bypass page CSP.
- The adapter passes the run's validated project permission mode into the
  browser/computer wrappers. `bypass` skips their additional origin/application
  access questions after target validation, without creating session or
  persistent grants. Later Ask runs therefore do not inherit bypass access.
- Ask/auto-edits prompts, Chromium's first-download consent, actual `ask`
  questions, operating-system permissions and driver restrictions remain.
  Cancelled tool calls fail before opening a bridge connection.
- Regression coverage includes the production adapter policy handoff, later
  Ask runs, model-supplied policy spoofing, real Chromium top-level await,
  Promise results, one-shot errors, CSP enforcement, size limits and interruption.

These are source/runtime checks, not new packaged-app acceptance. The installed
and published beta.10 app is unchanged until a new versioned build is released.

## Implemented surface

- A Bun NDJSON sidecar owns the persistent Chrome-for-Testing profile, tabs,
  structured CDP actions, input, downloads policy, and screencast frames.
- The Workspace Browser panel and GJC agent bridge share the same session tabs.
- Browser HTTP automation is available at `/api/browser/:sessionId`; the first
  PoC `/api/automation/browser/:sessionId` routes remain as compatibility aliases.
- `npm run browser:debug` is an HTTP-only client for the running server. It does
  not launch Chromium and accepts the desktop cookie through
  `GAJAE_BROWSER_DEBUG_COOKIE` when desktop authentication is enabled.
- CUA Driver remains an external prerequisite. The status surface reports its
  version, daemon state, Accessibility permission, and Screen Recording
  permission. Agent native actions are limited to the reviewed allowlist.
- Origin and application grants are session-scoped by default. Only an explicit
  “Always allow” persists; individual grants can be revoked in Settings.
- Stop closes the browser/CUA session, aborts active work, and clears session
  grants. A crashed sidecar reaps its owned Chromium process, restarts, restores
  tab URLs and the active tab, then resumes screencasting.

The PoC intentionally excludes file upload, automatic download saving, browser
extensions, existing Chrome profiles, force-quitting native apps, clipboard
reading, file transfer, screen recording, and lock-screen control.

## Automated evidence

The following passed on 2026-08-21:

- `npm run verify`: dependency audit, TypeScript, Rust formatting/clippy/tests,
  all server and client tests, lint, identity checks, and production builds.
- `npm run test:e2e:gjc`: seven driver/wire/browser integration scenarios.
- `npm run test:e2e:browser`: real Chrome-for-Testing actions, popup and tab
  state, navigation, dialogs, screencast, and interruption of a non-settling
  page script.
- Fake sidecar recovery integration: restart, orphan-browser reap, URL restore,
  active-tab restore, and screencast resubscription.
- Fake CUA and HTTP route integration: computer call, persistent grant creation,
  individual revoke, and the public `/api/browser/:sessionId` routes.
- `npm run smoke:packaged-server -- --tauri-app <app>` and strict `codesign`
  verification against the generated Tauri app bundle.

## Manual packaged-app evidence

The generated app at
`src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Gajae Code App.app`
passed these checks:

- Opened `http://100.78.133.28:8080/` in the Workspace Browser panel and showed
  the live todo-list Chromium frame.
- Killed only the owned browser sidecar. The app reaped the orphaned Chromium,
  started a new sidecar and Chromium process, restored the same URL and tab, and
  resumed the live frame without restarting the desktop app.
- Ran a Sol session using `computer.list_apps`; CUA Driver 0.21.0 returned that
  TextEdit was running and the app remained stable.
- Requested a previously unapproved `https://example.org` origin, selected
  **Deny**, and observed a failed-closed tool result while the shared browser
  stayed on the existing todo page.
- Started `browser.run` with a promise that never settles, pressed Stop, and
  observed cancellation and browser-session cleanup in 733 ms.

macOS Accessibility and Screen Recording were already granted for this test.
They were inspected but not revoked because changing OS privacy permissions is
outside normal app QA. Denied app-level origin access exercises the app's
fail-closed approval path without modifying system security settings.

## Upstream SDK dependency

`@gajae-code/coding-agent@0.15.0` provides the typed `automationTools` SDK
contract added by [gajae-code PR #4811](https://github.com/Yeachan-Heo/gajae-code/pull/4811).
The app supplies its host-owned `browser` and `computer` implementations through
that contract, so both surfaces are materialized as built-ins with canonical
activation and provenance. The SDK forwards the normal `AbortSignal`, rejects
same-name custom, extension, or MCP collisions, and does not create its default
browser or native controller for these injected surfaces.

`server/gjc-bun-sdk-adapter.ts` must continue to use `automationTools`, not
same-name `customTools`, and the downstream contract tests pin that boundary.
No direct `node_modules` patch is permitted.
