# Draft-first manual, updater-disabled release

This is a separate, explicit release lane for a signed/notarized **manual
installation only** app. It does not complete or claim auto-install acceptance.
`local-release.mjs` and CI retain their updater key, archive/signature/manifest,
eight canonical assets, and full archive/DMG equivalence requirements unchanged.
Do not supply fabricated updater keys or publish updater metadata for this lane.

The parent owns source freeze, accepted builds from that exact commit, signing,
notarization, release notes, draft creation/upload, and actual publication.
Runtime, standard packaged-server smoke, separate data-survival smoke, GUI and
Linux acceptance remain parent prerequisites. For a test prerelease, record the
actual macOS version tested separately from the declared loader floor. Do not
claim macOS 13 execution from loader stamps or a macOS 26 test; real minimum-OS
qualification remains a separately disclosed pending result.
Independent SHA-256 pins identify the operator's accepted local artifacts;
they are not reproducible-build provenance. Never derive expected hashes from
the remote draft being checked.

## Exact assets

For beta.10, the required assets are:

- `gajae-app-desktop-2.0.0-beta.10-macos-arm64.dmg`
- `gajae-app-desktop-2.0.0-beta.10-macos-arm64.dmg.sha256`
- `gajae-app-server-2.0.0-beta.10-linux-x64-node22.tar.gz`
- `gajae-app-server-2.0.0-beta.10-linux-x64-node22.tar.gz.sha256`

Optional payloads are **only** the exact versioned
`gajae-app-desktop-2.0.0-beta.10-linux-x64.deb` and
`gajae-app-desktop-2.0.0-beta.10-linux-x64.AppImage`, each with its own independent
`--asset` pin and `.sha256` sidecar. Their installer/platform acceptance is
separate; this verifier checks their hashes and sidecars only.

Every checksum is exactly `LOWERCASE_SHA256  PAYLOAD_BASENAME` on one line.
Updater `.app.tar.gz`, `.sig`, `desktop-update.json`, unlisted payloads,
unlisted sidecars, duplicates, incomplete uploads and missing assets all block.
Existing assets are never removed or replaced to make the set pass.

## Verify the local DMG before parent-owned smoke/GUI acceptance

After signing/notarization/stapling are complete, use the helper with the
explicit manual flag. A separately versioned verifier-only correction does
not change the frozen app/Linux source or release-tag target. The published
UI-inclusive beta.10 installers and verifier both use
`4979b2c49f54f79c51bf4f72cdca59c7b98ed44f`. Earlier UI-excluded candidates were
superseded and never published. Documentation-only follow-ups may advance HEAD;
read identity/config/manifest pins from the frozen release source, not an
assumed current checkout. See `docs/RELEASE-BETA10-ACCEPTANCE.md`.

```js
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyMacosRelease } from './scripts/release/local-release-macos.mjs';

// Verify these source files against the frozen release commit first;
// verifier-only HEAD may differ and must be recorded separately.
const source = JSON.parse(await readFile('package.json', 'utf8'));
const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
const runtimeManifestSha256 = createHash('sha256')
  .update(await readFile('server/gjc-runtime-manifest.json')).digest('hex');
const root = await realpath(await mkdtemp(join(tmpdir(), 'gajae-manual-acceptance-')));
const verified = await verifyMacosRelease({
  dmg: process.env.DMG, // Absolute path to the final accepted candidate image.
  root, // Fresh, owner-only, outside any checkout/node_modules ancestor.
  teamId: '5987KT43TJ',
  version: source.version, // 2.0.0-beta.10
  desktopVersion: source.desktopVersion, // 0.2.4
  minimumSystemVersion: config.bundle.macOS.minimumSystemVersion, // 13.0
  manualDisabled: true,
  runtimeManifestSha256,
});
console.log(JSON.stringify({ root, copiedApp: verified.copiedApp,
  buildInfo: verified.buildInfo, deployment: verified.deployment }, null, 2));
```

Do not pass `updaterArchivePath` with `manualDisabled: true`; even a null or
empty archive option is rejected. Omitting the manual flag **still requires**
a verified updater archive and complete archive equivalence.

The helper verifies the DMG and both mounted/copied apps: expected Developer ID
team, hardened app signatures, staples, Gatekeeper, package and desktop versions,
arm64 executables, and the pinned macOS minimum. Every inventoried regular file
is checked for Mach-O magic (including universal binaries and extensionless
helpers). macOS binaries must have supported macOS loader stamps no newer than
the declared minimum, including any MACOS binary placed in an iOS folder.
The sole non-Mac resource exception is beneath the canonical
`Contents/Resources/resources/server-payload/node_modules/` path:
`bare-*/prebuilds/ios-(arm64|x64)(-simulator)?/*.bare`. Each discovered resource
is still inspected with vtool and must have structurally valid, uniform `IOS`
stamps for device folders or `IOSSIMULATOR` stamps for simulator folders.
Unknown platforms, malformed/duplicate/mixed evidence, mismatched folders and
foreign binaries anywhere else fail. Named required runtimes/modules remain required.
`deployment.nonMacResourceCount` and `deployment.nonMacResources` record the
inspected exclusions (path, platform and minimum versions), separately from
macOS-only `deployment.stamps` and `maximumStampedMinimumSystemVersion`.
These resource exclusions are not macOS runtime qualification or a signature exemption.
Full mounted/copy inventories must match in bytes, modes and internal symlinks.

Only **after all copied-app validation** does the helper execute
`Contents/MacOS/gajae-app-desktop --desktop-build-info`, directly and without
UI/browser IPC. Timeout: 10 seconds. Stdout: an exclusively created, owner-only
file capped at 4 KiB while streaming. Stderr must be empty (the shared command
transport also has an 8 MiB total diagnostic-stream cap). The diagnostic must
exit successfully with exactly this eight-field JSON schema, without extras,
duplicates or missing fields:

```json
{
  "schemaVersion": 1,
  "packageName": "gajae-app",
  "productVersion": "2.0.0-beta.10",
  "desktopVersion": "0.2.4",
  "debug": false,
  "updateMode": "disabled",
  "runtimeManifestSha256": "<SHA256 of the pinned source runtime manifest bytes>",
  "payloadRuntimeManifestSha256": "<SHA256 of the finalized signed payload manifest>"
}
```

Finalization signs nested native modules and restamps their runtime manifests,
then rebuilds the desktop with that exact finalized manifest digest before the
outer app signature. The original source digest stays separate. The two values
must match their respective pinned source and verified signed payload bytes;
runtime startup still enforces an exact compiled payload digest (no fallback).

These are compile-time constants from the early CLI path, before app, QA,
profile, updater or lifecycle initialization. No absence-of-assets inference
is accepted. The copied app inventory is checked again after the diagnostic.

On success, the image is detached and `copiedApp` remains for the parent's
separate standard/data-survival/GUI acceptance. The API caller owns the temp
directory. If detachment cannot be confirmed, the helper throws with
`preserveDirectory: true` and reports the directory: inspect/detach before any
cleanup. Never recursively remove a directory that may contain a mounted image.

## Existing draft verification and explicit publication

The parent creates one unpublished draft with the exact full commit as its
target, reviewed manual/updater-disabled notes, correct prerelease status and
the accepted asset set. Do not use a branch target or clobber existing assets.
The manual CLI never signs, notarizes, installs, creates drafts, uploads files,
reads signing keys, or changes tags directly. It uses the parent's existing
authenticated `gh` session only when the parent invokes it for verification.

From the frozen release checkout, supply explicit reviewed values:

```sh
verify_args=(
  --repo devswha/gajae-code-app --draft-id "$DRAFT_ID"
  --tag v2.0.0-beta.10 --commit "$RELEASE_COMMIT" --team-id 5987KT43TJ
  --asset "gajae-app-desktop-2.0.0-beta.10-macos-arm64.dmg=$DMG_SHA"
  --asset "gajae-app-server-2.0.0-beta.10-linux-x64-node22.tar.gz=$SERVER_SHA"
)
node scripts/release/manual-release.mjs "${verify_args[@]}"
# Only after acceptance and review, with other draft/tag publishers stopped:
node scripts/release/manual-release.mjs "${verify_args[@]}" --publish
```

The first command is read-only on GitHub and reports `verified-draft`. The
second re-downloads and repeats every check before one numeric release-ID
`gh api ... --method PATCH --field draft=false`. Publication may cause GitHub
to create an absent tag at the exact pinned target; an existing lightweight or
annotated tag must already resolve to that commit. Title, notes, prerelease
status and the exact asset snapshot must be preserved in the response.

Every invocation verifies remote commit/package identity, raw source manifest
SHA-256, full independently pinned downloads and checksum sidecars, server
archive root package identity, strict Mac validation and positive disabled
binary evidence. Complete published desktop-version history must be proven,
and the candidate must advance beyond the history and the existing `0.2.3`
baseline. After local validation, private download bytes, history, draft
metadata/paginated assets, and tag are checked again. Missing or changed
evidence blocks publication. Download snapshots use exclusive file creation
inside private temp directories, inspected byte-count streaming caps and
read-only payload files. Existing shared payload/metadata limits apply.

CLI temp downloads and copied apps are cleaned normally; use the local API
above for a retained acceptance copy. API exports for orchestration/tests are
`manualReleaseOptions(values)`, `validateManualDraft(release, options)` and
`processManualRelease(options)`. No prior report bypasses verification.

Exit codes: 0 for success, 2 for invalid CLI arguments, 1 for verification or
publication errors. Before publication, errors report `blocked`. Any failure
after the publication request starts reports `publication-outcome-unknown`,
including unexpected responses and cleanup failures. Inspect the exact release
ID before any retry. There is no automatic retry, rollback or asset deletion.
The last recheck and PATCH are not atomic: single-publisher/no-concurrent-edits
discipline is required.
