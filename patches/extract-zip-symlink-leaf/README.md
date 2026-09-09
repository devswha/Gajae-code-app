# extract-zip 2.0.1: bounded symlink-leaf backport

Reviewed 2026-09-09: upstream PR160 was open/unmerged at commit
`148750acb10c574818906de2a99aa13d457d5329`. The canonical manifest records the
upstream URL and exact index.js before/after SHA-256 values. The only source
change is the upstream `lstat(dest)` / `isSymbolicLink()` rejection immediately
before `createWriteStream`. No SDK/Puppeteer upgrade or new dependency.

## Scope and remaining limits

An archive can plant a symlink then reuse its leaf name for a regular file.
The backport rejects that write, including dangling or pre-existing symlinks.
Normal files, directories and safe symlinks still extract. Existing parent-path
realpath checks are unchanged. Symlinks are not globally prohibited.

This is **archive-only** protection, not a sandbox. A concurrent same-UID local
writer can race the lstat/open interval; later consumers can follow extracted
symlinks. Neither property is fixed or promised here. Extraction can leave
partial contents and rejected symlinks behind, as upstream does.

`scripts/check-audit.mjs` recognizes GHSA-7pqw-9j4j-h8q3 only with this exact
installed patch. The older GHSA-jmr9-qjv8-65gv retains its constrained-use
exception (Puppeteer's pinned vendor browser download, not app-supplied hostile
archives), now also patch-required; PR160 is not claimed to resolve that
advisory's full scope. Both records have a review date and expire 2026-11-30.
Missing/changed advisories require review; unknown high/critical advisories,
expired records, missing patches and unrecognized installations still fail.

## Integrity and lifecycle

`npm ci` postinstall invokes `scripts/apply-extract-zip-patch.mjs`. For an already
installed tree use `npm run apply:extract-zip-patch`; for verification use
`npm run check:extract-zip-patch`. Never hand-edit installed sources.

The dependency-free helper pins the whole canonical manifest, exact version,
unchanged package.json digest (including resolution metadata), and full
index.js pre/post digests. It validates before an atomic same-directory rename,
preserves permissions, rechecks the result, and is idempotent. Unknown bytes
are refused, not replaced. It rejects nested/aliased extract-zip copies and
linked npm installation slots; it does not fall back to ancestor dependencies.
The repository/helper are the trust root, not protection against local code
tampering by an actor who controls that trust root.

Dev, server build, tests, verify and audit check without silently applying.
Server and desktop stages carry only the helper, manifest and optional README,
retain the install hook during dependency installation, then keep a check-only
runtime script. Both staging and out-of-tree packaged smokes run the shipped
checker. SDK lifecycle policy, its 32-file inventory and runtime hashes are
independent and unchanged.

Targeted coverage: `scripts/apply-extract-zip-patch.test.mjs`,
`scripts/check-audit.test.mjs`, and `scripts/release/*extract-zip*.test.mjs`,
plus the existing server/desktop staging suites. Archive tests run the real
extractor with real ZIP bytes, including an unpatched negative control.
