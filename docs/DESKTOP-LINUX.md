# Linux desktop (x86_64)

> **Out of active development (owner decision, 2026-09-09).** The macOS app
> is completed first. This guide and the Linux packaging scripts are kept
> for reference and for explicit owner requests only; the CI lane below is
> dispatch-only and does not gate merges. Do not carry Linux desktop items
> forward as remaining work.

Gajae Code App has a native Tauri 2 Linux desktop build path producing `.deb`
and `.AppImage` packages. Each package carries the web client, server, Rust
core, native dependencies, **Node.js 22.22.2**, and **Bun 1.4.0**. An installed
package uses its bundled runtimes; building from source requires Node and Rust.

Linux desktop is available as a source/local build. No published Linux desktop
download is claimed here. The Linux desktop workflow uploads build artifacts
for validation and does not publish a GitHub Release or send announcements.

## Compatibility and validation status

The current source combines `main` at `6d98bee` (PR #35), qualified SDK
`0.16.4` from `8d62924`, and review fixes `5f4c948` / `b97d90f` through merge
`10c8ebc`. New Linux CI package builds and package/GUI checks are pending for
this combined tree. See [the audit record](LINUX-DESKTOP-AUDIT.md) for its
separate local source qualification.

The following results are historical evidence from 2026-09-05 UTC /
2026-09-06 KST, after integrating the original Linux audit with `main` at
`5137be4` through merge `2048955`, using SDK `0.15.6`. They do not qualify
new SDK `0.16.4` packages.

| Environment | Result |
| --- | --- |
| Ubuntu 22.04.5, glibc 2.35 (container) | Built both formats; native hashes, auth, WebSockets, terminal reconnection, data survival, AppRun Python/gio and OCR GUI passed |
| Installed Ubuntu 22.04 Debian package | Installation, desktop entry validation, URI argument support/MIME registration and two GUI launches passed |
| Ubuntu 24.04.4, glibc 2.39 (host) | The same Ubuntu 22.04 artifacts passed backend, AppRun environment and two-launch OCR GUI checks |
| Rust desktop shell | 37 tests passed; 11 separate X11/Openbox activation, Retry and startup-close checks passed on the audited debug shell |
| Native Wayland | One earlier-package startup/render probe passed under Weston 9 headless pixman, without Xwayland; not a final-package GNOME/KDE close/relaunch acceptance |
| Other targets | Linux arm64, musl/Alpine and cross-compilation are not covered |

That historical source gate passed: `npm run verify` included 61 native-core
tests, 708 Node server tests, 469 Node client tests, 134 script tests and the separate
Bun groups. See [the audit record](LINUX-DESKTOP-AUDIT.md) for fixes, focused
checks and remaining limitations. GitHub workflow execution is recorded separately
from the local/container results.

Linux Workspace Browser is enabled. On hosts where the managed Chromium sandbox
is blocked, the app can retry installed stable Google Chrome with the same
private app profile. Explicit executable overrides are respected and the app
never adds `--no-sandbox`. A compatible installed browser or working managed
sandbox is still required; native CUA computer control is not automatically
enabled on Linux.

The historical local artifacts below were built on glibc 2.35. A later local build
on Ubuntu 24.04 declares its own newer libc requirement and does not establish
Ubuntu 22.04 compatibility. AppImage does not remove operating-system requirements.

The original audit retained local evidence under
`.desktop-build/linux-audit-evidence/` and
`.desktop-build/linux-audit-final-artifacts/`; these generated files are not
committed or published release assets.

## Build prerequisites

Use an x86_64 Ubuntu 22.04 or 24.04 host. Install the Tauri 2 system libraries
and build tools before `npm ci`:

```bash
sudo apt-get update
sudo apt-get install --no-install-recommends -y \
  build-essential pkg-config curl wget file unzip git ca-certificates \
  libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev \
  libxdo-dev libssl-dev librsvg2-dev patchelf xdg-utils libnss3
```

Install Node.js **22.22.2** for parity with desktop CI, plus Rust through
rustup. General source development also accepts the Node ranges in
`package.json.engines`; the desktop payload always pins its own Node runtime.
The workflow uses Rust 1.85.1 with rustfmt:

```bash
rustup toolchain install 1.85.1 --profile minimal --component rustfmt
rustup override set 1.85.1
rustup target add x86_64-unknown-linux-gnu
node --version                       # v22.22.2 in desktop CI
rustc --version
getconf GNU_LIBC_VERSION             # record this with the build result
```

Run these commands from the repository root. Fetch Bun through the repository
script so its pinned download and checksum checks apply:

```bash
node scripts/release/prime-ripgrep-cache.mjs
npm ci
node scripts/fetch-bun.mjs
dist-native/bun --version            # 1.4.0
```

The ripgrep cache helper verifies the pinned binary before installation and
avoids depending on an authenticated GitHub API request during postinstall.

## Build the packages

```bash
npm run desktop:build:linux
```

This command uses `scripts/release/build-linux-desktop.mjs` to build the payload,
clear stale Tauri staging directories, run Tauri with
`--bundles deb,appimage --target x86_64-unknown-linux-gnu -- --locked`, restore
the AppImage runtime, and stage both packages with
`scripts/release/stage-linux-desktop.mjs`.
To build just the embedded payload, use `npm run server:payload:linux`.

`linuxdeploy` can modify ELF RPATHs in Bun and Gajae native bindings.
`scripts/release/restore-linux-appimage.mjs` restores the verified runtime to
the assembled AppDir, checks native hashes against the runtime manifest, and
recompresses it using Tauri's AppImage output plugin. This preserves manifest
integrity after `linuxdeploy` modifications. Staging and final checksums run
after restoration.

The wrapper unsets `CI` to avoid Tauri's rejection of `CI=1` and defaults
`APPIMAGE_EXTRACT_AND_RUN=1` so AppImage build tools can run without a FUSE
mount. The npm command and canonical output names remain the same.

The canonical staged output uses **`package.json.version`**, rather than
the shell's separate `desktopVersion`:

```text
release/desktop/gajae-app-desktop-<version>-linux-x64.deb
release/desktop/gajae-app-desktop-<version>-linux-x64.deb.sha256
release/desktop/gajae-app-desktop-<version>-linux-x64.AppImage
release/desktop/gajae-app-desktop-<version>-linux-x64.AppImage.sha256
```

Historical audited artifacts (Ubuntu 22.04 x86_64, glibc 2.35, SDK `0.15.6`):
these checksums identify the earlier packages only. The combined SDK `0.16.4`
tree has not yet produced qualified Linux packages; record its new CI artifact
checksums and results separately, even though the package version is unchanged.

| Format | Size | SHA-256 |
| --- | --- | --- |
| `.deb` | 165.3 MiB | `6d0a5eb07c94586bd625bcde79fda76e79befd1d18b12901048af8b4460187c1` |
| `.AppImage` | 212.9 MiB | `ec409149ee9775a4f9670226baa7448c19ec33a9bda82c89719bc4892e0a3b99` |

Tauri's intermediate packages live under
`src-tauri/target/x86_64-unknown-linux-gnu/release/bundle/`. Keep generated
payloads, runtimes, Cargo targets and `release/` artifacts out of commits.

From the repository root, check both staged packages:

```bash
LINUX_VERSION="$(node -p "require('./package.json').version")"
LINUX_ASSET="gajae-app-desktop-${LINUX_VERSION}-linux-x64"
(
  cd release/desktop
  sha256sum --check "$LINUX_ASSET.deb.sha256"
  sha256sum --check "$LINUX_ASSET.AppImage.sha256"
)
dpkg-deb --info "release/desktop/$LINUX_ASSET.deb"
```

## Install or launch a local build

Run these after the build and checksum commands above, in the same shell.
On a graphical Ubuntu desktop, install the Debian package with apt so its
declared system dependencies are resolved:

```bash
sudo apt install "./release/desktop/$LINUX_ASSET.deb"
gajae-app-desktop
```

You can also launch **Gajae Code App** from the applications menu. Rebuilding
the same desktop version and installing the local `.deb` again may require
`sudo apt install --reinstall "./release/desktop/$LINUX_ASSET.deb"`.

For the AppImage:

```bash
chmod +x "release/desktop/$LINUX_ASSET.AppImage"
"./release/desktop/$LINUX_ASSET.AppImage"
```

If the system cannot mount AppImages through FUSE, use extraction at launch:

```bash
APPIMAGE_EXTRACT_AND_RUN=1 "./release/desktop/$LINUX_ASSET.AppImage"
```

The desktop shell needs a graphical session with GTK/WebKitGTK available.
It starts its bundled server on loopback; no separate Node/Bun installation
or manually started server is needed. Keep Git, CA certificates, and `libnss3` installed
on the host; the `.deb` declares `git` and `ca-certificates` as dependencies,
and AppImage users must provide them too. `libnss3` supplies Chromium’s NSS/NSPR libraries. App data lives outside the package in
`~/.gajae-app`, and GJC configuration and credentials live in `~/.gjc`.
Keep these directories when replacing a package or AppImage.

## Verify the extracted packages

Run the packaged-server harness from this checkout, pointing it at an
extraction **outside the checkout**. This prevents Node or Bun from resolving
a dependency accidentally omitted from the package through the repository's
`node_modules`. Extraction does not require installing the `.deb` or mounting
the AppImage with FUSE.

With `LINUX_ASSET` set as above, check the `.deb`:

```bash
(
  set -euo pipefail
  LINUX_ROOT="$(mktemp -d /tmp/gajae-deb-smoke.XXXXXX)"
  trap 'rm -rf "$LINUX_ROOT"' EXIT
  dpkg-deb -x "release/desktop/$LINUX_ASSET.deb" "$LINUX_ROOT"
  npm run smoke:packaged-server -- --linux-root "$LINUX_ROOT"
  npm run smoke:packaged-server -- --linux-root "$LINUX_ROOT" --data-survival
)
```

Then check the AppImage's `squashfs-root`:

```bash
(
  set -euo pipefail
  APPIMAGE="$(pwd)/release/desktop/$LINUX_ASSET.AppImage"
  EXTRACT_DIR="$(mktemp -d /tmp/gajae-appimage-smoke.XXXXXX)"
  trap 'rm -rf "$EXTRACT_DIR"' EXIT
  chmod +x "$APPIMAGE"
  (cd "$EXTRACT_DIR" && "$APPIMAGE" --appimage-extract >/dev/null)
  npm run smoke:packaged-server -- --linux-root "$EXTRACT_DIR/squashfs-root"
  npm run smoke:packaged-server -- --linux-root "$EXTRACT_DIR/squashfs-root" --data-survival
  npm run smoke:packaged-server -- --linux-root "$EXTRACT_DIR/squashfs-root" --appimage-env
)
```

Pass the extracted root to `--linux-root`, not its `usr/bin` directory or the
payload directory. The standard smoke checks bundled runtime/native loading,
health identity, bootstrap authentication, API access and a job round trip.
The separate `--data-survival` invocation checks state through shutdown and
restart. These use temporary app data; neither invocation is GUI acceptance.

## Automated X11 GUI smoke

`scripts/release/smoke-linux-desktop.py` exercises the actual packaged Tauri
window. Install its additional test prerequisites (no pip packages required):

```bash
sudo apt-get install --no-install-recommends -y \
  python3 python3-gi python3-xlib gir1.2-gtk-3.0 \
  xvfb xauth dbus-x11 libgl1-mesa-dri fontconfig fonts-dejavu-core \
  tesseract-ocr tesseract-ocr-eng
```

After the standard and data-survival smokes, run the GUI harness **before
deleting the extracted root**. For a `.deb` extraction:

```bash
python3 scripts/release/smoke-linux-desktop.py \
  --linux-root "$LINUX_ROOT" --format deb \
  --artifacts /tmp/gajae-gui-deb
```

For an extracted AppImage:

```bash
python3 scripts/release/smoke-linux-desktop.py \
  --linux-root "$EXTRACT_DIR/squashfs-root" --format appimage \
  --artifacts /tmp/gajae-gui-appimage
```

The harness starts its own Xvfb display and private D-Bus session, with
software rendering and English UI text. It launches the `.deb` executable or
the AppImage's `AppRun` from a fresh temporary home with isolated XDG paths,
database, agent directory, and instance-lock directory. It strips inherited
credentials, provider configuration paths, loader overrides, and proxies,
and refuses a packaged `.env`. It uses no provider sign-in or provider calls.
No WebKit sandbox-disabling flags are needed; run it as a regular user.

Each of two launches using the same temporary state must pass all of these:

1. A visible app-owned window and a bundled server whose `/health` product,
   protocol and version match the checkout.
2. Two consecutive app-window screenshots, at least one second apart, whose
   OCR contains the full empty-workspace heading and both project/scratch
   actions. OCR ignores whitespace/punctuation differences. A blank window,
   loading screen or recovery page cannot satisfy those content assertions.
3. `WM_DELETE_WINDOW` returns exit code `0`; tracked descendants, including
   WebKit grandchildren and adopted orphans, exit; the sidecar TCP port refuses
   a connection. PID start times distinguish exited processes from reused PIDs.

Forced cleanup after failure does not count as successful shutdown. The
temporary app state is deleted. `--artifacts` requires an empty directory and
retains `report.json`, per-launch
screenshots, OCR text, application logs and the private session log. This is
an X11 empty-workspace smoke; it does not validate Wayland, provider workflows,
desktop-menu integration or user-data migrations. Keep the server's separate
data-survival check.

The old local `.desktop-build/qa-desktop.py` saved screenshots without checking
their content and tracked only immediate children. Its results remain useful
local evidence, but do not establish this stricter automated gate.

Run focused regression tests without GUI libraries or a package build:

```bash
python3 scripts/release/smoke-linux-desktop.py --self-test
node --test scripts/release/smoke-linux-desktop.test.mjs
```

## CI and acceptance evidence

`.github/workflows/desktop-linux.yml` runs on manual dispatch only (it used to
run on pull requests and pushes to `main`). The workflow:

1. Requires an x86_64 Ubuntu 22.04 build host with glibc 2.35 and Node 22.22.2.
2. Installs the system prerequisites and pinned Bun, then builds both packages.
3. Checks Tauri Rust formatting and runs the shell's locked Cargo tests after
   the build, when the required payload sidecar exists.
4. Requires exactly the two canonical packages and their valid SHA-256 files.
5. Uploads `gajae-app-desktop-linux-x64` as a workflow artifact, retained for
   14 days.
6. Downloads those same bytes on Ubuntu 22.04 and 24.04 and checks both extracted
   formats with the standard and data-survival smoke invocations.
7. Runs the automated GUI gate for both formats on each host, then retains
   screenshots, OCR text, logs and reports as `gajae-linux-gui-<runner-os>` for
   14 days. Evidence upload runs even when a preceding smoke fails; inspect
   each report's status and the workflow result.

The desktop shell checks can also be run locally after building the packages:

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && \
  cargo test --locked --manifest-path src-tauri/Cargo.toml
```

The upload happens before the downstream smoke jobs; an artifact's existence
alone is not a passing result. Check the whole workflow. The existing source
CI still runs `npm run verify`, which checks the Rust core but does not run
the Tauri shell's Cargo tests. The test scanner includes
`scripts/release/*.test.mjs` in that existing gate, including the Linux GUI
helper's dependency-free Python self-tests through their Node wrapper. The
desktop matrix also runs that focused wrapper before launching packages.
The protected release workflow is unchanged and does not
attach these Linux desktop packages to a release.

For acceptance, record the commit SHA, host/architecture, glibc version,
package filenames and checksums, build result, each smoke result, and whether
the package was built locally or downloaded from CI. Preserve the distinction
between an Ubuntu 24.04 local build and the Ubuntu 22.04 CI baseline.

On an actual Linux desktop, separately exercise package install/launch,
the rendered window, provider sign-in links opening the browser, a session
create/abort/resume cycle, quit/relaunch persistence, and sidecar cleanup.
Record the desktop environment and whether the session uses X11 or Wayland.
Leave any unrun step marked **not run**. Do not infer Linux GUI success from
the [macOS verification record](DESKTOP-TAURI-VERIFICATION.md).
