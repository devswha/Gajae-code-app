# Isolated macOS desktop acceptance

The installed binary accepts an explicit `--qa-profile /absolute/directory`
on macOS 14 or newer. Ordinary launches keep the normal user profile. QA
launches use a separate persistent WebKit data-store UUID, application/agent
database, home, scratch projects, browser caches and instance lock. The server
environment is rebuilt from an allowlist, so parent provider keys, custom
agent paths, Node options and shell configuration are not inherited.

Use a fresh empty directory outside the checkout and an accepted app copy:

```sh
QA_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/gajae-desktop-qa.XXXXXX")"
QA_ROOT="$(cd "$QA_ROOT" && pwd -P)"
"/absolute/path/Gajae Code App.app/Contents/MacOS/gajae-app-desktop" \
  --qa-profile "$QA_ROOT"
```

Only empty directories or existing profiles with a matching root-bound
`desktop-qa-profile.json` are accepted. Existing user/project directories,
copied profile manifests and symlinked managed directories are refused. Do not
copy the normal agent credential database into QA. The profile does not grant
credentials, change app permissions, or disable workflow guards.

Quit and relaunch the same binary with the same argument to check persistence.
The desktop stores its first verified loopback port in `desktop-port` in the
profile's app data directory and reuses it. This keeps local UI settings on the
same origin. Per-launch API credentials still rotate, and PID/health identity
verification precedes navigation. An occupied saved port causes recovery rather
than silently choosing a different origin; release the conflicting listener
and Retry. The normal desktop uses its own app-local data directory for this
record. A first launch cannot recover preferences from older random ports.
Use a second empty profile to check that sidebar data and appearance settings
are independent. Verify the supervised Node process exits after quitting.
The dedicated WebKit store is managed by macOS and persists independently of
the filesystem profile; keep its UUID with the QA evidence. Deleting the QA
directory alone does not erase that WebKit store. QA profiles are not portable.
No production browser profile is inspected or copied by this mechanism.

QA pins the automation bridge to the short `a.sock` path directly under its
private profile root. This avoids silently truncated Unix socket names when
the child inherits a long profile-specific `TMPDIR`. Roots that cannot fit the
platform socket address capacity are rejected before the profile is initialized.
Updater preparation's real-app QA is recorded separately in
[DESKTOP-UPDATER-QA-PREPARATION.md](DESKTOP-UPDATER-QA-PREPARATION.md).

The bundled runtime requires macOS 13 or later. On macOS 13, QA mode refuses
startup rather than silently falling back to WebKit's default store. Other
platforms reject this option. A disposable OS account remains useful for
first-install permissions/LaunchServices testing and is required for QA on
macOS 13. Profile-based GUI checks do not claim clean-machine coverage.

Record the source commit/tree, artifact hashes, profile UUIDs and separate
results for launch, sign-in link, settings/project persistence, fresh-profile
isolation, quit and child-process cleanup. Do not put authentication callback
URLs, cookies, keys or passwords in the record. OMG skill execution is outside
the current acceptance scope at the user's request.
