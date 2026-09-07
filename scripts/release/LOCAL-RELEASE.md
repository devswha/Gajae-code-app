# Publish a locally signed release through an existing draft

This route works with empty hosted signing secrets. Build and notarize on the
existing Mac using its Developer ID identity and `gajae-notary` profile, create
one **draft** with the finished assets, then run the explicit local verifier.
Only its `--publish` invocation makes that exact draft public. The hosted
workflow's unsigned-publication guard remains in force; do not dispatch it for
this local route.

The tool never creates a release, uploads/replaces/deletes an asset, changes a
tag, signs an artifact, reads a signing private key, or exports credentials.
It needs the existing authenticated `gh` session, official Minisign **0.12**,
the trusted updater public-key file, and macOS arm64 verification tools.
A publish request can cause GitHub to create the draft's still-absent
tag at its pinned target commit. Existing tags must already resolve to that
same commit, including annotated tags.

## Prepare the final candidate

The parent owns the final integrated commit/version and all build, Linux,
runtime, data-survival and GUI acceptance. Complete those gates before this
procedure. Build the Mac app at that exact commit, sign with the existing
identity, notarize/staple the app, build/sign/notarize/staple the DMG, and
regenerate its checksum **after** stapling. Keep `APPLE_SIGNING_IDENTITY`
exported throughout that build. No credential or PKCS#12 export is needed.
The existing signed-build instructions remain in
`docs/DESKTOP-TAURI-VERIFICATION.md`.

The first updater-enabled build requires one manual DMG installation:
beta.9 has no updater. Its `desktopVersion` must exceed both `0.2.3` and every
previously published desktop version across beta/stable. Product version is
display/tag identity; it is not the install-order counter. Missing historical
tag/commit/package mappings block publication, rather than lowering the floor.
Real signed/notarized A-to-B acceptance, authorization approve/cancel behavior,
recovery, lifecycle and data-survival gates remain required before publication.

The macOS bundle minimum is **13.0**. This is a loader requirement, not merely
an `Info.plist` declaration: the verifier runs `xcrun vtool -show-build` on
the desktop and server executables, Bun/Rust payload runtimes, and bounded
native runtime modules discovered in the app inventory. Every `LC_BUILD_VERSION`
`platform MACOS` `minos` stamp must be present, well-formed, supported, and no
newer than the pinned `minimumSystemVersion`. A declaration of 11.0 therefore
cannot pass when Bun (or another bundled Mach-O) requires 13.0. macOS 13
execution itself remains a separate acceptance gate.

After final app/DMG acceptance, create the updater archive with
`make-macos-updater.mjs`. It verifies a private quarantined app copy, packs the
unchanged final app, invokes the official Tauri signer, verifies a private
snapshot with `minisign -V -H`, and compares the extracted archive with the
DMG app (all member bytes, modes and symlink targets). It never signs/staples
the app itself. Do not recompress or modify an archive after signing.

Keep the updater private key and its backup under the approved key-custody
procedure. Supply `TAURI_SIGNING_PRIVATE_KEY_PATH` or
`TAURI_SIGNING_PRIVATE_KEY` only through the signer's supported environment;
encrypted keys also need `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Never put key
contents/passwords on argv, in release assets or in logs. The verifier accepts
only the public-key file. No key generation, credential export, or production
signing is implied by these instructions.

For the final SDK 0.16.4 candidate, `scripts/release/MACOS-ACCEPTANCE.md`
provides the pinned source snapshot, isolated build paths, bounded local
notarization, quarantined copy verification, and separate packaged smokes.

Use the exact same source commit for the Linux server archive and any optional
Linux desktop artifacts. Keep independent SHA-256 values from the accepted
local builds; do not take the expected hashes from the remote draft being
verified. The tool checks source/package versions and those independently
supplied byte hashes. It cannot prove which source produced a binary with the
same version, and does not claim reproducible-build provenance.

In a shell at the reviewed checkout, set these values explicitly:

```sh
. "$HOME/.nvm/nvm.sh"
nvm use 22
REPO=devswha/gajae-code-app
RELEASE_COMMIT=REPLACE_WITH_REVIEWED_FULL_40_CHARACTER_COMMIT
test "$(git rev-parse HEAD)" = "$RELEASE_COMMIT"
git diff --quiet
git diff --cached --quiet
VERSION="$(node -p "require('./package.json').version")"
TAG="v$VERSION"
TEAM_ID=5987KT43TJ
DMG=/absolute/path/to/accepted/macos.dmg
APP="/absolute/path/to/accepted/Gajae Code App.app"
SERVER=/absolute/path/to/accepted/server.tar.gz
NOTES=/absolute/path/to/reviewed-release-notes.md
UPDATER_PUBLIC_KEY=/absolute/path/to/trusted/updater-public.key
UPDATER_DIR=/absolute/path/to/new/updater-assets
minisign -v # must report minisign 0.12
node scripts/release/make-macos-updater.mjs \
  --app "$APP" --dmg "$DMG" --output "$UPDATER_DIR" \
  --commit "$RELEASE_COMMIT" --team-id "$TEAM_ID" \
  --updater-public-key-file "$UPDATER_PUBLIC_KEY" --notes-file "$NOTES" \
  --pub-date "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
DMG="$UPDATER_DIR/gajae-app-desktop-$VERSION-macos-arm64.dmg"
UPDATER="$UPDATER_DIR/gajae-app-desktop-$VERSION-macos-arm64.app.tar.gz"
MANIFEST="$UPDATER_DIR/desktop-update.json"
test "$(basename "$DMG")" = "gajae-app-desktop-$VERSION-macos-arm64.dmg"
test "$(basename "$SERVER")" = "gajae-app-server-$VERSION-linux-x64-node22.tar.gz"
test -f "$DMG.sha256"
test -f "$SERVER.sha256"
DMG_SHA="$(shasum -a 256 "$DMG" | awk '{print $1}')"
UPDATER_SHA="$(shasum -a 256 "$UPDATER" | awk '{print $1}')"
SERVER_SHA="$(shasum -a 256 "$SERVER" | awk '{print $1}')"
```

The displayed file paths are placeholders: use the canonical filenames tested
above. Each `.sha256` file must contain one line, `HASH  BASENAME`, without an
absolute/relative directory path or extra entries. Existing publication files
are never rewritten by this tool. Fix malformed sidecars only in the new local
candidate's staging directory before draft creation.

## Create an unpublished draft, then verify it

A draft is unpublished; do not treat draft assets as secret storage. Never
include signing material. The commands below are for the parent to invoke
after acceptance, not a workflow to dispatch. `gh release create` must fail
if a release already exists for the tag; do not delete/recreate it or use an
asset upload with `--clobber` to get past that failure.

```sh
prerelease_args=()
if [[ "$VERSION" == *-* ]]; then prerelease_args+=(--prerelease); fi
gh release create "$TAG" \
  "$DMG" "$DMG.sha256" "$UPDATER" "$UPDATER.sig" "$UPDATER.sha256" \
  "$MANIFEST" "$SERVER" "$SERVER.sha256" \
  --repo "$REPO" --target "$RELEASE_COMMIT" --draft \
  --title "Gajae Code App $TAG" --notes-file "$NOTES" \
  "${prerelease_args[@]}"

gh release view "$TAG" --repo "$REPO" \
  --json databaseId,tagName,targetCommitish,isDraft,isPrerelease,assets
DRAFT_ID="$(gh release view "$TAG" --repo "$REPO" --json databaseId --jq .databaseId)"

verify_args=(
  --repo "$REPO" --draft-id "$DRAFT_ID" --tag "$TAG" --commit "$RELEASE_COMMIT"
  --team-id "$TEAM_ID" --updater-public-key-file "$UPDATER_PUBLIC_KEY"
  --asset "$(basename "$DMG")=$DMG_SHA"
  --asset "$(basename "$UPDATER")=$UPDATER_SHA"
  --asset "$(basename "$SERVER")=$SERVER_SHA"
)
node scripts/release/local-release.mjs "${verify_args[@]}"
```

Successful output has `status: "verified-draft"`, the exact repo, numeric draft
ID, tag, commit, team and computed hashes for all assets. Default invocation
performs no GitHub write. Missing arguments exit 2; any validation failure
exits 1 and leaves the draft and its assets intact. An already-public release
is refused before downloads or publication.

There are six mandatory macOS assets and two mandatory server assets. The
manifest and updater signature are typed bounded sidecars, not extra
checksum-bearing payloads. `--mode ci` requires exactly those eight assets.

For additional explicitly pinned payloads, including Linux desktop builds,
include each artifact and checksum sidecar in
the initial draft creation and append one `--asset "BASENAME=SHA256"` entry per
payload to `verify_args`. Unknown or missing assets block publication rather
than being ignored or removed. The canonical Mac DMG, signed updater archive,
manifest/signature sidecars and Linux server archive remain mandatory.
Optional payloads receive hash/sidecar validation here;
their platform/installer acceptance remains with their packaging owner.

## Explicit publication, after reviewing the verification result

Stop other publishers and edits to this draft/tag for the final invocation:

```sh
node scripts/release/local-release.mjs "${verify_args[@]}" --publish
```

This re-downloads and re-verifies everything; a previous report is not a bypass.
After validation it changes only `draft` to `false` on the specified numeric
release ID using `gh api ... --method PATCH --field draft=false`. This has the
publication effect of `gh release edit "$TAG" --draft=false`, but binds the
write to the verified ID rather than looking up the tag again. It preserves
notes, title, prerelease status and every existing asset. Do not run an
unguarded `gh release edit --draft=false` after an old verification report.

Each invocation requires:

- An unpublished draft with the exact tag and full `target_commitish`; branch
  targets such as `main` are rejected. The remote commit must exist and its
  `package.json` must match the app name and tag version.
- An exact asset set matching the caller's independent hashes and sidecars,
  including uploaded state, IDs, lengths and any supplied GitHub digests.
  Downloads use asset IDs and exclusively created temporary files.
  Each download is streaming-capped to its inspected byte count.
- The Linux archive's root package name/version and the copied Mac payload's
  package name/version. `CFBundleIdentifier` and desktop version are checked
  independently against product identity and the pinned source commit.
- Developer ID signatures from the explicitly named team, hardened app
  runtime, valid DMG/app staples, Gatekeeper acceptance, and arm64 desktop and
  sidecar binaries. The app is checked both on the read-only mount and after
  copying to a quarantined writable location outside a checkout.
  The updater-extracted app receives the same checks, including the pinned
  minimum macOS version and exact DMG/app inventory equivalence.
- Strict manifest version/channel/repository/target/commit/URL binding,
  signature-sidecar agreement and real Minisign verification over the same
  immutable archive snapshot that is extracted.
- Complete bounded published-history discovery and a strictly advancing
  desktop version, checked again before publication.
- Unchanged draft metadata/assets and tag after downloads and verification,
  immediately before the optional publication request.

The last recheck and publication request are separate operations. They are
**not atomic**; the single-publisher/no-concurrent-edits requirement is part of
this procedure. Drafts remain mutable, and repository release immutability is
not enabled or changed by this tool. A publication transport error can have an
unknown outcome: inspect the exact release ID before any retry. The tool never
automatically retries, deletes assets, or moves a public release back to draft.
Errors after requesting publication report `status: "publication-outcome-unknown"`
and exit 1; they do not claim that the release stayed unpublished.

Command waits are bounded: 2 minutes for metadata/local verification commands,
10 minutes per download, and 30 seconds per history request within a five-minute
history pass. Local releases allow at most 16 explicitly pinned payloads plus
their checksum sidecars and the two updater metadata sidecars. The updater
archive/DMG cap is 250 MiB; expanded updater tar data is capped at 1 GiB.
All
temporary downloads and copies are removed normally. If image detachment
cannot be confirmed, the tool retains and reports its temporary directory;
inspect/detach that mount before deleting it. It never recursively removes a
directory that may still be mounted.

Implementation validation on September 6, 2026 (KST) included a fresh download
of the already-published beta.8 DMG (asset ID `542909888`). Its recorded SHA-256
`d4484b203846ffac92dd870c63aa0c7d7124c1130ac10499b8eb9730bcbad2d8`
matched; the real macOS checker passed signatures, expected team, staples,
Gatekeeper, mounted/quarantined-copy verification, package/desktop versions
and arm64 binaries. The temporary image/copy were removed after detachment.
The six-asset updater builder was also exercised against this same cached,
independently pinned image using a disposable updater key. Real Developer ID,
staple and Gatekeeper checks passed for the mounted, quarantined and
updater-extracted apps; complete archive/DMG inventories matched. That
historical package declares 11.0 while its Bun Mach-O is stamped 13.0, so the
new deployment-floor guard correctly rejects it; the earlier run demonstrates
signing/inventory tooling only and is not current release acceptance. The
original image remained unchanged and temporary copies/mounts were cleaned up.
No new signing, release acceptance, or installed A-to-B behavior is claimed.

No new candidate was built, draft created, release published or signing
credential exported while implementing this route. The parent must run it
against the final integrated, accepted artifacts.
