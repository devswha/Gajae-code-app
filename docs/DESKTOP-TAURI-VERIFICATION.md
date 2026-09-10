# Tauri Desktop (macOS arm64) — Verification Record

Linux x86_64 `.deb`/`.AppImage` builds and their separate validation procedure
are documented in [DESKTOP-LINUX.md](DESKTOP-LINUX.md). The macOS results below
do not establish Linux package or GUI compatibility.

> **Status (2026-07-22): beta.3 rename and reinstall QA passed; C7
> complete, C8 void, C9 complete.** The beta.3 installed-app smoke covered the
> visible rename, project/session navigation, preset and skill-command UI,
> task abort/resume, and quit/relaunch persistence. The interactive
> GUI smoke was executed end-to-end on the installed DMG build, driven through
> gjc computer use (screenshots, drive transcript, QA report, and re-drill logs
> under `artifacts/g002/`). Electron was removed in C9/wave1, which also voids
> the C8 Electron↔Tauri rollback drill.
>
> **Update (2026-09-02): the Developer ID signing + notarization gate is
> cleared.** A Developer ID Application certificate and the `gajae-notary`
> notarytool profile are on the Mac, and the first signed build was notarized,
> stapled and accepted by Gatekeeper (record below). Nothing has been tagged or
> published from it: the packaged smoke run from the mounted image failed
> because the payload's `elkjs` exclusion broke worker start-up outside the
> the repository tree. **Fixed the same day** (record below): a first-party stub
> now stands in for the removed package, and every packaged smoke runs from a
> copy outside the checkout. The next signed build starts from that HEAD.

> **Loader-floor correction (2026-09-07): historical signed beta.8/beta.9
> bundles declare `LSMinimumSystemVersion=11.0`, but the bundled Bun 1.4.0
> Mach-O carries `LC_BUILD_VERSION minos 13.0` (the other inspected runtime
> binaries were 11.0). The release verifier now requires a pinned 13.0
> minimum and independently checks the desktop/server executables, Bun/Rust
> runtimes, and bounded native modules with `xcrun vtool -show-build`; it does
> not trust `Info.plist` alone. The historical six-asset builder run therefore
> demonstrates signing/inventory tooling but is rejected by this stricter
> guard, and is not new release acceptance or signing evidence. The static
> loader floor does not establish that execution on macOS 13 succeeds.**

## Build the artifacts (on the Mac)

```sh
cd ~/workspace/gajae-code-app
npm ci
npm run server:payload:macos            # darwin-arm64 Node payload + externalBin
GJC_UPDATE_MODE=disabled env -u CI npm run tauri -- build --bundles app # ad-hoc .app bundle (no updater)
npm run desktop:dmg:macos               # headless functional DMG via hdiutil + sha256
```

Artifacts:
- `src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/gajae-app-desktop-2.0.0-beta.3-macos-arm64.dmg`
- `src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/gajae-app-desktop-2.0.0-beta.3-macos-arm64.dmg.sha256`

The `Release Gajae Code App` GitHub Actions workflow performs the same build,
mount, nested-signature, architecture, bundle-version, native-closure, and
packaged-server smoke checks before attaching both files to the versioned
GitHub Release. The DMG build fails if it exceeds 250 MiB.

Final local beta.3 candidate:

- Size: `235611893` bytes (224.7 MiB)
- SHA-256: `c185e65228587c3b0e87039bd205c22ea400e78fdcb5dac53a6477b8591a26e1`
- Installed bundle: `/Applications/Gajae Code App.app`, desktop version `0.2.2`
- Deep code-signature verification and packaged native/Bun loading smoke: pass

## beta.8 — signed + notarized, accepted from the copy-out — **PASSED 2026-09-03 (23:45 KST)**

Built at `2f58f27` (package version `2.0.0-beta.8`) following the signed
release procedure. First release workflow run (33766237655) failed in the
Linux job's Verify source: the debug-bundle test assumed the sessions table
exists — on CI's fresh HOME it does not, and the lookup threw. Fixed in
`2f58f27` (bundle assembles without a row) and the DMG was rebuilt from that
commit, not the stale first build.

- App notarization `5870d421-e0ba-4a03-ba69-719753392b63` → Accepted in
  3 min, stapled. DMG (APFS) notarization `54376a0d-413f-4162-9fcf-85afa66745d6`
  → Accepted in 3 min, stapled.
- Final image `223877660` bytes, SHA-256
  `d4484b203846ffac92dd870c63aa0c7d7124c1130ac10499b8eb9730bcbad2d8`.
- Acceptance: stapler validate on image and app OK; `spctl -t open/-t exec`
  → `accepted`, `source=Notarized Developer ID`; the quarantined
  `ditto` copy verifies deep+strict and Gatekeeper-accepts; packaged smoke
  `{"status":"ok","version":"2.0.0-beta.8"}`; `--data-survival`
  `events=1, schemas=idempotent`.
- Workflow rerun 33767561239 succeeded; the notarized image replaced the
  runner's ad-hoc asset and the download re-verified (checksum, staple).

## beta.7 — second image: “damaged” after install, fixed — **PASSED 2026-09-03 (19:18 KST)**

The 16:15 image below passed every check on its mount and was published;
installed through the browser and Finder it said “damaged and can't be
opened”. `codesign --verify --deep --strict` on `/Applications/Gajae Code
App.app`: `a sealed resource is missing or invalid` — `file added` **and**
`file missing`: `server-payload/node_modules/.bin/가재씨`.
`@gajae-code/coding-agent` publishes that Hangul bin alias; `hdiutil`'s
default HFS+ image stores the name in NFD, CodeResources sealed NFC, so the
copy Finder made to APFS carried bytes the seal did not know. The mount
itself verified because HFS+ normalizes on lookup.

Three fixes, all landed: the payload builder removes non-ASCII bin links and
refuses any other non-ASCII path (`removeNonAsciiPaths`, tested); the DMG
is built as APFS (`hdiutil create -fs APFS`); and the DMG builder, the CI
smoke and the documented acceptance now copy the app out of the mount and
verify it there, with a quarantine attribute, before anything ships.

Rebuilt at `ad877b5` + the fixes: app notarization
`66e0c11a-c638-4eac-9b4f-fcba88ee71b2` → Accepted in 3 min, stapled; DMG
notarization `79d06ee2-cf71-4587-b1d7-93153f4d1b8e` → Accepted in 3 min,
stapled. Final image `221972348` bytes, SHA-256
`328db060a3be36522075da2797c8acf2a6df93c7d859d880684409d36ba1d759`.
Acceptance from the mount: all green as before; **and** from a `ditto` copy
with a quarantine attribute: `codesign --verify --deep --strict` OK,
`stapler validate` OK, `spctl -a -t exec` → `accepted`,
`source=Notarized Developer ID`. Uploaded over the release asset, the
download re-verified (checksum, staple, copy-out), and the Mac's
`/Applications` install replaced from that download: launches, server
`/health` → `{"status":"ok","version":"2.0.0-beta.7"}`.

## beta.7 — Developer ID signed + notarized build, accepted from the mounted image — **PASSED 2026-09-03 (16:15 KST)**

Built at `d6e7826` (package version `2.0.0-beta.7`, desktop version `0.2.2`)
with `APPLE_SIGNING_IDENTITY` exported and `GITHUB_TOKEN` from `gh auth token`,
following the signed release procedure below.

- `server:payload:macos` 52 s → `tauri build --bundles app` 35 s →
  `desktop:sign:macos` 15 s; 27 nested Mach-Os signed, one native restamped.
  `codesign --verify --deep --strict` OK. Out-of-tree packaged smoke on the
  hardened app (the script copies it out of the checkout) → `{"status":"ok"}`.
- App notarization `cacf861b-4856-41a3-a959-4e131a1eec52` → `Accepted` in
  4 minutes (the 73-minute first submission was a one-off). Same single
  warning as before (`mammoth/test/test-data/empty.zip could not be
  unpacked`). Stapled and validated; `spctl -a -t exec` → `accepted`,
  `source=Notarized Developer ID`.
- **Mistake caught by acceptance, recorded so it is not repeated:** the first
  `desktop:dmg:macos` ran in a shell without `APPLE_SIGNING_IDENTITY`, so the
  image was ad-hoc signed (`Signature=adhoc`, `TeamIdentifier=not set`).
  notarytool still *accepted* that image and stapled it, but `spctl -a -t
  open --context context:primary-signature` rejected it. The identity has to
  be in the environment of every step, not only the sign step. The DMG was
  rebuilt with the identity (the stapled app inside was kept) and
  re-notarized: `fe911601-598b-46af-8041-d545ab753d91` → `Accepted` in
  3 minutes; stapled.
- Final image: `227303972` bytes (216.8 MiB), SHA-256
  `f0659df093ee0085caf636c2dc3caaf25cf419821b9e6eaace52e1f473244c55`
  (`.sha256` regenerated after stapling).
- Acceptance, all from the mounted image at `/tmp/gajae-dmg`: `stapler
  validate` on the DMG and the app → OK; `spctl -a -t open --context
  context:primary-signature` and `-t install` on the DMG → `accepted`,
  `source=Notarized Developer ID`; `spctl -a -t exec` on the app →
  `accepted`; `codesign --verify --deep --strict` → OK; packaged-server
  smoke → `{"status":"ok","version":"2.0.0-beta.7"}`; `--data-survival`
  → `events=1, schemas=idempotent`. The `elkjs` stub holds outside the tree.

This is the image to publish for `v2.0.0-beta.7`. The release workflow
builds an ad-hoc DMG on the runner (no signing secrets in CI), so the
notarized image and its `.sha256` are uploaded over the workflow's desktop
asset after the release is created.

## Post-beta.3 HEAD — First Developer ID signed + notarized build — **2026-09-02: signing/notarization PASSED, mounted-image smoke FAILED**

Built at `a4773ff` (package version `2.0.0-beta.7`, desktop version `0.2.2`)
on macOS 26.5.1 / Xcode 26.6, following the signed release procedure below with
`APPLE_SIGNING_IDENTITY` set to the Developer ID Application identity that
`security find-identity -v -p codesigning` lists (Team ID redacted here; the
identity string lives in the shell, not in the repository).

- `server:payload:macos` → `tauri build --bundles app` → `desktop:sign:macos`:
  154 s end to end (warm caches). The finalizer signed 27 nested Mach-Os with
  hardened runtime + secure timestamp and restamped one native
  (`@gajae-code/natives-darwin-arm64/native/pi_natives.darwin-arm64.node`).
- `codesign -dv --verbose=4` on the app, sidecar and `bun`:
  `flags=0x10000(runtime)`, `Authority=Developer ID Application → Developer ID
  Certification Authority → Apple Root CA`, `Timestamp=` present,
  `TeamIdentifier` set. `codesign --verify --deep --strict` → `valid on disk`,
  `satisfies its Designated Requirement`. Before notarization `spctl -a -t
  exec -vv` reported `rejected`, `source=Unnotarized Developer ID` — the
  expected intermediate state.
- Packaged-server smoke on the hardened-runtime app (before submission) passed,
  so the `bun` library-validation exception and the manifest restamp hold.
- App notarization: submission `c923fd4d-7d06-4957-afe1-4efda949e474` →
  `Accepted` / `Ready for distribution` after 73 minutes `In Progress` (first
  submission from the team). One warning only:
  `node_modules/mammoth/test/test-data/empty.zip could not be unpacked` — a
  test fixture, no executables; a candidate for the payload exclusion list.
- `xcrun stapler staple` + `validate` on the app → OK; `spctl -a -vv -t exec`
  → `accepted`, `source=Notarized Developer ID`.
- `desktop:dmg:macos` kept the stapled app (`appFinalized: kept`), 24 s,
  `221351468` bytes (211.1 MiB), DMG signed with the same identity.
- DMG notarization: submission `037874c4-0f85-4746-979c-aca31e496703` →
  `Accepted` after 3.5 minutes (same `empty.zip` warning). `xcrun stapler
  staple` + `validate` → OK; the stapled image is `221353557` bytes, SHA-256
  `15adf60e2431502b6efe3c42cd16eb5f985e52394ad1fc20dee8ba302af3cd02`
  (`.sha256` regenerated after stapling).
- Gatekeeper on the stapled artifacts: `spctl -a -t open --context
  context:primary-signature -vv` and `spctl -a -t install -vv` on the DMG →
  `accepted`, `source=Notarized Developer ID`; on the app inside the mounted
  image `spctl -a -t exec -vv` → `accepted`, `source=Notarized Developer ID`,
  `stapler validate` → OK, `codesign --verify --deep --strict` → OK.
- Packaged smokes on the stapled app **inside the repository tree**: standard
  run `{"status":"ok",…}` and `--data-survival` (`events=1,
  schemas=idempotent`) both passed.

**Not publishable yet — packaged smoke FAILS on the mounted image.** Both
smokes against `/tmp/gajae-dmg/Gajae Code App.app` fail at GJC job creation
with `GJC worker failed.`; the isolated HOME's `.gajae-app/logs/gjc-worker.log`
says why:

```
worker initialization failed: ResolveMessage: Cannot find package 'elkjs'
imported from …/server-payload/node_modules/beautiful-mermaid/src/elk-instance.ts
```

`b15492a` removes `elkjs` (EPL-2.0) from the payload on the assumption that
"nothing reaches it", but `beautiful-mermaid/src/elk-instance.ts` imports
`elkjs/lib/elk.bundled.js` statically and Bun evaluates it while loading
`@gajae-code/coding-agent`, so the worker never initializes. Every smoke so far
ran with the payload *inside this checkout* (`src-tauri/target/…`,
`src-tauri/resources/server-payload`), where Bun's resolver walks up to the
repository's own `node_modules/elkjs` and masks the hole. A copy of the same
app in `/tmp` fails identically, so it is the install location, not the
read-only mount. The `/Applications` install from 2026-08-31 14:41 predates the
exclusion and still carries `elkjs`, which is why the desktop kept working.
Run the acceptance smokes from the mounted image, never from the build tree.

### Fix — `elkjs` stub + out-of-tree smokes — **PASSED 2026-09-02 (evening, unsigned)**

What broke, precisely: `beautiful-mermaid/src/elk-instance.ts` has
`import ELKBundled from 'elkjs/lib/elk.bundled.js'` at module scope, and the
runtime touches ELK itself only inside `elkLayoutSync()` (`new ELKBundled()`,
then `instance.worker.worker.{onmessage,postMessage,dispatcher.saveDispatch}`),
which only the **SVG** layout of flowcharts, class and ER diagrams calls. The
ASCII renderer that `@gajae-code/utils` exposes never reaches it. `mupdf`, the
other exclusion, is loaded lazily (`require("mupdf")` / `await import("mupdf")`
inside `markit-ai`'s PDF converter) and needs nothing.

The fix, in three parts:

- `scripts/release/stubs/elkjs/` — a first-party MIT package (`gajae.stub:
  true`) exporting a class whose `layout()` rejects and whose fake worker
  answers every `saveDispatch` with `ElkLayoutUnavailableError` ("ELK layout is
  not bundled in this distribution"). `distribution-exclusions.mjs` names it as
  the `stub` of the `elkjs` entry; `removeExcludedDistributionPackages` deletes
  the real package, copies the stub into its place in **both** builders (the
  macOS payload and the Linux server bundle) and rewrites its version to the
  one removed. `npm test` now covers the install and the import surface
  (`scripts/release/*.test.mjs`).
- The payload builder and the server-bundle builder smoke the finished tree
  from a copy under the OS temp directory (`scripts/release/out-of-tree.mjs`),
  where no ancestor `node_modules` can supply what the artifact lacks.
- `smoke-packaged-server.mjs` detects an app that sits below a `node_modules`
  ancestor and copies it (via `ditto`) to the temp directory before smoking;
  `--from-copy` forces the copy anywhere. A mounted image or an installed app
  runs where it is.

Evidence, all on this Mac:

- Before the fix, the new smoke run against the 2026-09-02 notarized build in
  `src-tauri/target/…` (previously "passing" in place) copied the app out and
  failed with `GJC job creation failed (400): {"error":"GJC worker failed."}`
  — the same failure the mounted image showed, now reproducible from the tree.
- `npm run server:payload:macos` with the stub: `Excluded mupdf, elkjs;
  stubbed elkjs`, then `Smoking the payload from
  /var/folders/…/T/gajae-out-of-tree-… (outside the repository tree)` → built.
- The payload copied to `/tmp/gajae-payload-oot-*` (no `node_modules` above
  it) and the Bun worker driven by hand:
  `worker.initialize` → `{"ok":true}`, `worker.shutdown` → `{"ok":true}`,
  empty stderr. From the same copy,
  `renderMermaidAsciiSafe('graph TD\n A-->B')` renders and
  `renderMermaid(...)` (SVG) fails with `ElkLayoutUnavailableError` — the
  feature fails, not the runtime.
- Ad-hoc `tauri build --bundles app` on the new payload, then
  `smoke-packaged-server.mjs` (auto-copied to
  `/var/folders/…/T/gajae-packaged-smoke-app-…`):
  `{"status":"ok","product":"gajae-app","protocolVersion":1,"version":"2.0.0-beta.7"}`.
  `--data-survival` on the same copy: `events=1, schemas=idempotent`.

Not done here: the signed build and notarization. They start from this HEAD.

Also found and fixed on this run: the second `finalize-macos-app.mjs` pass that
`desktop:dmg:macos` used to run unconditionally moved the app's cdhash
(`a64ece98…` → `18b91f71…`) because every re-sign carries a fresh timestamp;
the script now leaves a stapled app untouched (see "What the packaging
pipeline does").

## Post-beta.3 HEAD — Transparent vector mark — **PASSED 2026-08-19 (00:42)**

Rebuilt and reinstalled at `91fe458`, carrying the uploaded transparent vector:
the in-app mark is now `mark.svg` with its own hat underside filled, and the six
plated `logo*.png` files are gone. Verified in the installed bundle:
`dist/mark.svg` hashes identically to the repository's and `dist/logo*.png`
returns nothing. Packaged-server smoke passed, signature verification passed,
and the app relaunched with its three processes.

Note: requesting `/mark.svg` from the packaged server over loopback answers 401
— it authenticates static assets too — so asset checks compare files inside the
bundle rather than HTTP responses.

## Post-beta.3 HEAD — Reframed icon — **PASSED 2026-08-18 (night)**

Rebuilt and reinstalled at `6949f86`, where the icon artwork was reframed 26%
larger and lower so the mark fills its tile. Signature verification passes, the
app relaunches with its three processes, and the bundled `dist/logo.png` hashes
identically to the repository's. Note that comparing an installed `.icns` to the
source PNG by hash is meaningless — `iconutil` re-encodes on extraction — so the
icon itself was confirmed by rendering it at 16 and 32px.

## Post-beta.3 HEAD — In-app mark rebuild — **PASSED 2026-08-18 (late evening)**

Rebuilt and reinstalled at `99bed13` after the icon generator was extended to
cover `public/logo*.png`. The bundled `dist/logo.png` now hashes identically to
the repository's, so the sidebar header, loading screen and gjc chat mark carry
the same artwork as the Dock icon. Signature verification passes and the app
relaunches with its packaged server.

## Post-beta.3 HEAD — Rebuild, smoke, and install — **PASSED 2026-08-18 (evening)**

Second rebuild of the day. The morning bundle was never installed, and eight
commits landed after it: the session-model picker fix, the model-catalog cache
fix, and the chat transcript work (tool rows, turn boundaries, reading measure,
typeface, bubble sizing).

Verified on darwin-arm64 at `14f6bd1`:

- Payload rebuilt; manifest pins `gjcSdk`/`natives` `0.14.0`.
- `env -u CI npm run tauri -- build --bundles app` produced the bundle.
- `smoke:packaged-server` reported `{"status":"ok","protocolVersion":1}`.
- Bundled client carries the day's work: `max-w-[68ch]`, `group/turn`,
  `chat.steer`, `statusTab`.
- Installed over `/Applications` after quitting the running instance, with the
  previous bundle copied to `/tmp` first. Deep signature verification passes,
  and the launched app runs its three processes with the packaged server
  answering on its loopback port.

Session data lives outside the bundle in `~/.gajae-app`, so projects, sessions
and logins survive the replacement.

## Post-beta.3 HEAD — Rebuild and packaged-server smoke — **PASSED 2026-08-18**

Ran because the installed `/Applications` bundle had drifted: built 2026-07-25
carrying GJC SDK 0.11.8, while HEAD had moved 40 commits and three SDK minors
ahead (0.14.0). Nothing shipped since beta.3 — the Workspace panel, Status tab,
the message queue, steering — existed in any desktop build.

Verified on darwin-arm64 at `10cbb6e`:

- `npm run server:payload:macos` — payload built, signed, and pruned (364 MB).
- `npm run tauri -- build --bundles app` — bundle produced. Note: the tauri CLI
  rejects `CI=1` (`invalid value '1' for '--ci'`); build with `env -u CI`.
- Payload manifest pins `gjcSdk`/`natives` `0.14.0`, matching the repo.
- `npm run smoke:packaged-server -- --tauri-app <app>` — packaged server reported
  `{"status":"ok","product":"gajae-app","protocolVersion":1}`.
- Launched bundle runs three processes: desktop shell, packaged server on a
  loopback port, and the `gajae-core` session watcher.
- The packaged client bundle carries this session's work: `chat.steer`,
  `workspace-panel`, `statusTab`, and `queued_message_` all present in
  `dist/assets`.

Not covered: on-screen interaction. A `computer` screenshot returned an all-black
frame (locked display or missing Screen Recording permission), so the window's
rendered state was confirmed through the served bundle rather than visually.

Not done: the freshly built app was NOT installed over `/Applications`. Until it
is, the desktop a user launches remains the 2026-07-25 / SDK 0.11.8 build.

## beta.3 — Rename and reinstall smoke — **PASSED 2026-07-22**

The previous `/Applications/Gajae App.app` and `~/.gajae-app` were moved to
Trash without emptying it. The final beta.3 DMG was installed through Finder
and exercised through Computer Use against a fresh data directory.

- [x] Every visible app, window, and menu identity is **Gajae Code App**.
- [x] The explicit `gajae-app` project survives relaunch, and its compact
      sessions expand directly beneath the project instead of being duplicated
      in Work while idle.
- [x] Model preset selection exposes built-in and custom presets, each with the
      default agent plus Planner, Executor, Architect, and Critic roles.
- [x] Typing `/` exposes the installed `/skill:adaptive-response` command.
- [x] A running task appears in Work, abort removes it, and reopening the same
      session after quit/relaunch accepts a follow-up and returns `QA_RESUMED`.
- [x] The fresh database promoted the auto-discovered project to `origin =
      'explicit'`; no prior `~/.gajae-app` database was restored.
- [x] No new Gajae Code App crash report or `Code Signature Invalid` event was
      created after the baseline timestamp.

The local DMG did not carry a quarantine attribute, so macOS did not show the
expected first-run Gatekeeper warning on this Mac. Cross-Mac QA must download
the GitHub Release asset so quarantine is applied and separately verify the
right-click **Open** flow. This does not change the expected `spctl` rejection
for the intentionally ad-hoc beta.

## C7 — Interactive GUI smoke — **PASSED 2026-07-20**

Executed against the then-named DMG install `/Applications/Gajae App.app` at HEAD
`36d7cb2`, driven exclusively through gjc computer use. Evidence:
`artifacts/g002/g002-gui-drive-transcript.{md,json}`, screenshots `00`–`16`,
`g002-qa-report.json`, `g002-packaged-smoke.log`, `g002-leader-evidence.log`.

- [x] **Launch**: DMG mount (hdiutil checksums verified) → drag-install →
      launch; one sidecar tree, loopback ephemeral port, key bootstrap,
      `/health` identity, React UI (not recovery). (screenshot 01)
- [x] **Job (GJC web execution)**: create job → live human-readable timeline →
      diff (`+C7-SMOKE-OK`) → commit `7142761` landed in the smoke target
      repository's managed worktree (`~/gjc-c7-test`, not this repo); sidebar
      rows show the live prompt snippet and relative `createdAt`.
      (screenshots 02–07)
- [x] **Abort**: mid-stream abort → terminal event `jobState=aborted`, durable
      run `aborted/aborted`, job returns to `ready`. (screenshots 08–09)
- [x] **Resume / follow-up**: interrupted job shows the follow-up composer →
      Resume streams a new run to completion; `ready` jobs take a next turn via
      `/turns` (composer added by ef6f076 after the smoke exposed the gap).
      (screenshots 10–11)
- [x] **Editor**: Files panel opens `README.md` and renders its content.
      (screenshot 16)
- [x] ~~**Terminal**~~ — **N/A by design.** The Shell/Git/Files tabs were
      deliberately removed on 2026-07-11 (see the comment at
      `src/components/main-content/view/subcomponents/MainContentTabSwitcher.tsx:22`);
      the current product has no user-facing terminal surface.
- [x] **Window close keeps job alive**: red-button close hides the window; the
      sidecar tree survives and the running job completes while hidden; Dock
      reopen restores the window and timeline. (screenshot 12 + DB evidence)
- [x] **Quit graceful → interrupted**: quitting with a running job drives the
      shutdown fence — whole tree exits, durable state `interrupted`, and the
      job resumes cleanly on next launch. Verified through the macOS Quit
      AppleEvent, the same `applicationShouldTerminate` path Cmd-Q takes
      (unified-log evidence). A literal Cmd-Q keystroke could not be
      synthesized: the gjc `computer` keypress map has no modifier key names
      (root-caused, ledger-recorded; no fallback tooling was substituted).
- [x] **Deep link**: `open "gajae-app://open/job/<id>"` focuses the window and
      navigates the SPA to `/jobs/<id>` (Rust-validated id, pushState eval;
      36d7cb2). Malformed/foreign/traversal URLs are rejected by both the Rust
      and TS validators. (screenshot 13)
- [x] **Recovery/Retry**: SIGKILL of the sidecar shows the diagnostic recovery
      page; Retry (CSP-safe listener + `withGlobalTauri`, 2e584b9) respawns the
      sidecar and restores the React UI. (screenshots 14–15)
- [x] **Single instance**: a second launch exits cleanly (no SIGABRT
      crash-reporter dialog; 9bdc18d) and the running instance keeps focus.
- [x] **Gatekeeper**: `spctl --assess` rejects the ad-hoc build — the expected
      pre-notarization state (`g002-gatekeeper.log`).

Defects found and fixed by this smoke: `9bdc18d` (second-instance SIGABRT),
`60b26b6` (macOS Quit AppleEvent orphaned the server tree), `ef6f076` (no
follow-up affordance for `ready` jobs), `2e584b9` + `36d7cb2` (dead recovery
Retry; deep links did not navigate).

## C8 — Electron ↔ Tauri rollback drill — **VOID**

Electron was removed in C9/wave1 (`285ddea`), so there is no rollback target.
The drill's data-survival axis is covered continuously by the automated
two-boot cross-restart smoke below (rerun on the final build: PASS, gap-free
replay, idempotent schemas).

## C9 — Electron removal — **DONE (wave1, `285ddea`)**

`electron/`, `prepare-desktop-app.js`, Electron scripts/config and deps are
gone; the Windows Job Object code is retained. `npm run verify` and the mac
cargo/DMG/smoke lanes are green on the Tauri-only tree.

## Public-distribution gate — Developer ID signing + notarization

This gate was deferred until beta.3 functional QA was complete and the product
owner decided to continue public distribution. See Phase 7 in
`docs/V2-PLAN.md` for the ordered readiness checklist.

Since 2026-09-02 the Mac carries a **Developer ID Application** certificate
(`security find-identity -v -p codesigning` → 1 valid identity) and the
`gajae-notary` notarytool keychain profile. Every DMG shipped *before* that
date is ad-hoc signed and `spctl -a -t exec -vv` reports `rejected` for it;
the first Developer ID signed build is recorded above.

### What the packaging pipeline does

`scripts/release/finalize-macos-app.mjs` takes its identity from
`APPLE_SIGNING_IDENTITY` (ad-hoc when unset) and, for whatever identity it is
given:

- signs every Mach-O in the bundle — found by file magic, not by a name list,
  because a vendored binary outside such a list (`@vscode/ripgrep`'s `rg`, the
  GJC natives) ships unsigned and fails notarization;
- signs with the hardened runtime and, for a real identity, a secure timestamp;
- gives `bun` the sidecar's library-validation exception, without which dyld
  refuses the GJC addon (`mapping process and mapped file have different Team
  IDs`) as soon as the runtime is hardened;
- restamps `gjc-runtime-manifest.json` inside the bundle after signing. Signing
  a native rewrites its bytes and the bundled worker refuses to start unless it
  still hashes to the pinned value (`GJC runtime manifest validation failed.`).
  The manifest is verified against the installed bytes *before* signing, so
  provenance is still checked; the restamp records what actually ships and runs
  before the outer signature seals the bundle.

`scripts/release/make-macos-dmg.mjs` signs the disk image with the same
identity, because an unsigned image cannot carry a stapled ticket. When the app
it packages is already stapled (`Contents/CodeResources` present) it verifies
the bundle and its ticket instead of re-running the finalizer: re-signing is
not byte-identical — each secure timestamp changes the nested signatures the
resource seal hashes, so the bundle's cdhash moves and the stapled ticket would
no longer match the app inside the image.

### Prerequisites on the Mac (done 2026-09-02)

- An **Apple Developer Program** membership (99 USD/year) and a **Developer ID
  Application** certificate in the login keychain
  (Xcode → Settings → Accounts → Manage Certificates → +, or a CSR through
  developer.apple.com; keep the private key).
- Notarization credentials, stored once (the credentials live in the keychain
  only; nothing in the repository carries them):

```sh
# App Store Connect API key (preferred; no password in the keychain)
xcrun notarytool store-credentials gajae-notary \
  --key ~/private_keys/AuthKey_XXXXXXXXXX.p8 --key-id XXXXXXXXXX --issuer <issuer-uuid>

# or an app-specific password from appleid.apple.com
xcrun notarytool store-credentials gajae-notary \
  --apple-id you@example.com --team-id TEAMID1234 --password abcd-efgh-ijkl-mnop
```

### Signed release procedure

Cut the release with the identity exported (copy the string exactly as
`security find-identity` prints it):

```sh
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID1234)"
security find-identity -v -p codesigning        # must list that identity
export GITHUB_TOKEN="$(gh auth token)"          # see note below

npm run server:payload:macos
GJC_UPDATE_MODE=disabled env -u CI npm run tauri -- build --bundles app  # Tauri's own ad-hoc pass
npm run desktop:sign:macos                      # re-signs everything with the identity

# 1. notarize the app, so a copied-out .app carries its own ticket
ditto -c -k --keepParent \
  "src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Gajae Code App.app" /tmp/gajae-app.zip
xcrun notarytool submit /tmp/gajae-app.zip --keychain-profile gajae-notary --wait
xcrun stapler staple "src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Gajae Code App.app"

# 2. package and notarize the image the release publishes
npm run desktop:dmg:macos                       # keeps the stapled app as-is
DMG="src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/gajae-app-desktop-$(node -p "require('./package.json').version")-macos-arm64.dmg"
xcrun notarytool submit "$DMG" --keychain-profile gajae-notary --wait
xcrun stapler staple "$DMG"
shasum -a 256 "$DMG" > "$DMG.sha256"   # stapling changes the image
```

Notes from the first signed run (2026-09-02):

- `npm run server:payload:macos` runs `npm ci` inside the payload, and
  `@vscode/ripgrep`'s postinstall asks the GitHub API for its prebuilt binary.
  Anonymous requests share a 60/hour quota per IP, and with it exhausted the
  payload build dies with `Request failed: 403` after four retries. Exporting
  `GITHUB_TOKEN` (the postinstall honours it) lifts the quota to 5000/hour.
- `notarytool submit --wait` can sit in `In Progress` for a long time — the
  first submission from a new team took well over an hour. `xcrun notarytool
  info <id> --keychain-profile gajae-notary` reports the same status from
  another shell; there is nothing to fix locally while it is `In Progress`.
- Do not re-run `desktop:sign:macos` on a stapled app (see above); rebuild from
  `tauri build` instead if the bundle has to change.

Acceptance (all must pass before publishing a notarized DMG):

```sh
xcrun stapler validate "$DMG"
spctl -a -t open --context context:primary-signature -vv "$DMG"   # accepted
hdiutil attach "$DMG" -mountpoint /tmp/gajae-dmg -nobrowse
spctl -a -t exec -vv "/tmp/gajae-dmg/Gajae Code App.app"          # accepted, source=Notarized Developer ID
codesign -dv --verbose=4 "/tmp/gajae-dmg/Gajae Code App.app" 2>&1 | grep -E 'Authority|TeamIdentifier|flags'
node scripts/release/smoke-packaged-server.mjs --tauri-app "/tmp/gajae-dmg/Gajae Code App.app"
node scripts/release/smoke-packaged-server.mjs --tauri-app "/tmp/gajae-dmg/Gajae Code App.app" --data-survival
# What Finder does: copy out to a writable volume and verify THERE.
rm -rf /tmp/gajae-copy && mkdir /tmp/gajae-copy
ditto "/tmp/gajae-dmg/Gajae Code App.app" "/tmp/gajae-copy/Gajae Code App.app"
codesign --verify --deep --strict "/tmp/gajae-copy/Gajae Code App.app"         # OK, or it is "damaged" after install
spctl -a -t exec -vv "/tmp/gajae-copy/Gajae Code App.app"                    # accepted
hdiutil detach /tmp/gajae-dmg
```

Then, in the installed app (not the browser): open a provider sign-in and
press **Open sign-in link** — the OS browser must open. The webview is the
server's loopback origin, where Tauri IPC is not injected and `window.open`
goes nowhere; since `b4fd118`+1 external links travel through
`POST /api/system/open-url` (https only) and every `target="_blank"` anchor is
routed the same way. beta.7 shipped without this and its sign-in button did
nothing in the desktop app.

The copy-out step exists because of beta.7's first image (below): every check
on the mounted image passed, and the installed app said "damaged". The DMG
builder now runs the same copy-out verification itself and builds an APFS
image; the payload builder drops non-ASCII bin links and refuses any other
non-ASCII path.

The smokes must run against the *mounted image* (or any copy outside this
checkout). Run from `src-tauri/target/…` they used to pass while the shipped
app was broken, because Bun resolves missing payload packages from the
repository's own `node_modules` — exactly what hid the `elkjs` failure recorded
above. The script now refuses to be fooled: an app below a `node_modules`
ancestor is copied to the temp directory first (`--from-copy` forces this
anywhere), so the mounted image remains the canonical target and the in-tree
bundle is an honest stand-in during development.

If `notarytool submit` fails, read the reasons — they are specific:

```sh
xcrun notarytool log <submission-id> --keychain-profile gajae-notary
```

### Signing and notarizing in CI (the release workflow)

The `desktop-macos` job of `.github/workflows/release.yml` runs this same
procedure on the runner when the **`release` environment** carries these
secrets (Settings → Environments → `release`):

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE_P12` | The Developer ID Application certificate with its private key, exported from Keychain Access as `.p12`, then `base64 -i cert.p12 \| pbcopy` |
| `APPLE_CERTIFICATE_PASSWORD` | The password chosen when exporting the `.p12` |
| `APPLE_ID` | The Apple ID e-mail of the developer account |
| `APPLE_TEAM_ID` | The 10-character Team ID (`security find-identity` prints it in parentheses) |
| `APPLE_APP_PASSWORD` | An app-specific password from appleid.apple.com, for `notarytool`; never the account password |

With them the job imports the certificate into a throwaway keychain, exports
`APPLE_SIGNING_IDENTITY` for every later step (the sign step *and* the DMG
step - see the ad-hoc-image mistake recorded above), signs, notarizes and
staples the app, builds the image, checks it is Developer ID-signed, notarizes
and staples it, regenerates the `.sha256`, and in the mounted-image smoke
requires `stapler validate` and `spctl -a -t exec` → `source=Notarized
Developer ID`. The keychain is deleted at the end of the job.

Without `APPLE_CERTIFICATE_P12` the job builds the ad-hoc image it always has
and says so in the log. `APPLE_CERTIFICATE_P12` set with any of the other four
missing fails the job rather than shipping a half-signed image. The
environment's secrets are only released to a `workflow_dispatch` from `main`,
never to a pull request.

## Automated packaged-server smoke (Mac)

```sh
node scripts/release/smoke-packaged-server.mjs \
  --tauri-app "/Applications/Gajae Code App.app"

node scripts/release/smoke-packaged-server.mjs \
  --tauri-app "/Applications/Gajae Code App.app" --data-survival
```

The standard run verifies `/health` identity, one-time desktop bootstrap
(`HttpOnly` cookie + `303 /`), unauthenticated API denial, exact-Origin
authenticated API access, and a GJC job create/list/abort round trip against
an isolated temporary HOME/database. `--data-survival` adds the two-boot
durability drill (graceful shutdown → restart → gap-free replay, idempotent
migrations, resume). Both passed on the final C7 build
(`artifacts/g002/g002-packaged-smoke.log`).
