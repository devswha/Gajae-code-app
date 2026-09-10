# Desktop updates: check automatically, install only after a click

The user's September 9, 2026 request supersedes the previous automatic-download
and automatic-next-launch-install policy. The new interaction is a compact
notice immediately above Settings in the bottom-left sidebar.

![Update notice above Settings — UI fixture, not a live installation](images/updater/click-update-notice.png)

## Behavior

1. The existing schedule discovers release metadata only. An eligible release
   becomes `available`; merely checking or opening the app does not download it.
2. The user presses **Update**. Native download admission binds the exact
   offered target; it does not rediscover and silently substitute a newer one.
3. After signature/archive verification, the same document requests one
   target-bound safe restart. Draft sealing, backend admission, owned-process
   shutdown, installation journal and successor health gates remain mandatory.
4. Discovery is an anonymous GitHub API client and shares the per-IP primary
   limit (60 requests/hour) with every other anonymous caller on the network.
   An exhausted limit answers 403 with `x-ratelimit-remaining: 0`; the check
   then waits for `x-ratelimit-reset` instead of polling every minute, the
   snapshot reports `discovery_rate_limited`, and a manual check inside that
   window is refused rather than retried. Rate-limited responses do not
   consume quota, so the wait ends at the reset. The app's own share is kept
   near zero: listing pages are re-requested with `If-None-Match` (an
   unchanged page answers 304, which GitHub does not charge) and a manifest is
   fetched once per release/asset ID for the life of the process, so a quiet
   6-hourly check costs no quota and a new release costs two requests. Cached
   bodies are re-validated by the same stamps and manifest checks and are
   discarded with the cursor on any hard discovery error.
5. Busy work, target changes, connection loss, errors and unknown state stop
   that UI attempt. There is no automatic restart retry when work later ends.
   Rate-limited clicks are rejected without queueing a hidden download; retry
   requires another user click after the limit expires.

`automatic` retains its wire/preference field name but means **automatic checks**
only. Neither `automatic: true` nor an existing verified cache permits next-launch
installation. Only a matching explicit manual restart intent can proceed into
the existing native install gate. Legacy schema-1 unbound intents are not accepted;
new schema-2 intents bind both the target ID and the actual archive SHA-256.
The first admitted startup durably consumes that selection before location,
network or installation preflight. If preflight fails, a later ordinary launch
does not replay the click; a fresh explicit request is needed. An existing
installation journal retains its separate verified-successor recovery path.

## State and authority

- `shared/desktopUpdateProtocol.ts` owns the UI contract. Snapshot `targetId` is
  required (nullable without a target); `download` and `restart` require it.
  The native ID hashes a fixed domain, release/asset IDs and raw manifest bytes.
  Restart rechecks both the snapshot and prepared record, including same-version
  substitutions. The browser supplies no URL, path, signing key or installer.
- This native updater interface has not been publicly enabled. Its strict
  protocol-1 schema evolves as one bundled native/server/client unit: old partial
  snapshots and unbound commands fail closed, with no compatibility fallback.
  Private backend framing and draft challenge protocols are unchanged.
- One document-scoped client shares polling, pending mutations and the user's
  click between Sidebar and About. Sidebar mode swaps preserve its stable owner;
  full unmount or bridge replacement retires the click. A UI timeout does not
  cancel or duplicate native execution.
- Ordinary web and updater-disabled builds show no native sidebar update action.
  A retained disconnected snapshot is read-only; Refresh performs only a status
  read. Dismissal is in-memory and target-specific, surviving sidebar mode swaps
  while allowing a different target to surface.
- Unknown download progress is indeterminate, never a fabricated percentage.
  The collapsed rail exposes a labelled details icon directly above bottom
  Settings. English, Korean and all other existing settings locales retain key
  parity. About uses the same state and explains checks-only behavior.

## Verification scope

Focused checks cover the shared client/real injected bridge, HTTP/protocol
validation, native discovery/explicit download, cached startup consent,
same-target restart, cancellation, duplicate clicks, stale responses, rate limits,
Sidebar/Settings behavior and locale parity. Full source and native gate results
are recorded in the current handoff.

- Full `npm run verify` passed (`/private/tmp/gajae-click-update-full-verify-final.log`).
- Native clippy with `-D warnings` and all native tests passed: 340 unit + 10
  binding tests; 6 dedicated/optional helpers ignored
  (`gajae-click-update-consume-clippy.log`, `gajae-click-update-native-accepted.log`).
- Shared client, actual injected bridge, Sidebar and About DOM union: 59 passed;
  HTTP/relay/protocol union: 76 passed. Native tests include one-shot intent
  consumption across reopen and concurrent consumers, and rate-limited clicks
  without hidden delayed retries.

Browser visual QA renders the actual SidebarFooter/SidebarCollapsed/update
components with the app CSS and React Compiler in a clearly labelled local
state fixture. At the native minimum 960×640, the expanded card fits above
Settings (card bottom 556px; Settings top 562px). Light/dark, indeterminate
download, collapse/expand, dismissal and new-target redisplay were checked.
The fixture recorded one download and one restart request after the explicit
click. This is **UI/protocol evidence, not actual app replacement**.

This change has not yet been rebuilt into a new signed two-version QA pair or
publicly enabled installer. Earlier signed automatic-update QA proves the old
policy only; do not reuse it as acceptance of this click-based flow.

## Current installed beta.11 and bootstrap

The previously delivered beta.11 / desktop 0.2.5 DMG is updater-disabled and
unchanged. To update it now, the user installs a newer DMG manually after quitting
the app. It cannot receive this implementation through an update button it lacks.

A first click-update-enabled installer therefore still requires one manual
installation. Subsequent releases can use the sidebar button after production
binding, signed artifact acceptance and the remaining release gates are complete.
The UI fixture does not enable production updates, create a release or modify
the user's installed application.
