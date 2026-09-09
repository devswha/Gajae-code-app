# Contributing to Gajae Code App

Gajae Code App is a self-hosted web and desktop interface for GJC. Small,
well-explained changes are easier to review and safer to release.

## Start with the existing work

- Search [issues](https://github.com/devswha/gajae-code-app/issues) and [pull requests](https://github.com/devswha/gajae-code-app/pulls) before opening a duplicate.
- Open an issue first when a change affects product behavior, APIs, or architecture.
- A focused bug fix may be submitted directly when its cause and scope are clear.

## Local setup

Install Git, a supported Node.js release (`>=22.22.2 <23` or `>=24.15.0 <25`),
and the GJC tooling needed for the area you are changing. Then create a branch
from your fork and install dependencies:

```bash
git clone https://github.com/<your-account>/gajae-code-app.git
cd gajae-code-app
npm install
git switch -c fix/short-description
```

Run the development servers with:

```bash
npm run dev
```

Useful commands:

| Command | Purpose |
| --- | --- |
| `npm run server:dev` | Run the backend through `tsx`. |
| `npm run client` | Start the Vite development server. |
| `npm run build` | Build the client, server, and native core. |
| `npm run typecheck` | Check the TypeScript projects. |
| `npm test` | Run the repository test suite. |
| `npm run lint` | Check JavaScript and TypeScript style. |
| `npm run check:identity` | Validate the product and release identity. |
| `npm run server:payload:macos` | Build the embedded macOS server payload and sidecar (prerequisite for the Tauri shell tests). |
| `env -u CI npm run tauri -- build --bundles app` | Assemble an unsigned, ad-hoc macOS app bundle. |
| `npm run server:payload:linux` | Build the Linux x64 self-host server payload with pinned Node 22.22.2 and Bun 1.4.0. |

### Desktop development

The desktop target under active development is **macOS on Apple Silicon**.
The Linux desktop app is out of scope until the macOS app is complete: its
packaging scripts and [docs/DESKTOP-LINUX.md](docs/DESKTOP-LINUX.md) are kept
but not maintained, and its `.github/workflows/desktop-linux.yml` lane runs
only on manual dispatch. Do not send Linux desktop changes unless a
maintainer asked for them.

`.github/workflows/desktop-macos.yml` runs on pull requests, pushes to
`main`, and manual dispatch on `macos-14`. It builds the embedded server
payload, checks Tauri Rust formatting, runs the shell's locked Cargo tests,
and assembles an ad-hoc app bundle. It uploads nothing and publishes nothing.
Ordinary source verification remains in the existing CI workflow; `npm run
verify` covers the Rust core, not the Tauri shell tests.

For desktop changes, build the bundle locally (`npm run server:payload:macos`
then the ad-hoc `tauri build`), run the copied-app smoke in
[docs/DESKTOP-TAURI-VERIFICATION.md](docs/DESKTOP-TAURI-VERIFICATION.md),
and record the host, commit, and results. Headless server checks do not
verify the desktop window: report interactive GUI checks separately, and do
not describe unrun checks as passed.

## Repository map

- `src/` contains the React client, UI components, translations, and browser utilities.
- `server/` contains the HTTP server, runtime integration, routes, and backend services.
- `shared/` holds code shared between browser-facing and server code.
- `native/gajae-core/` contains the Rust native core.
- `public/` provides static browser assets.
- `docs/` contains installation and operational guidance.

## Change expectations

Keep one concern in each pull request. Describe the problem, the resulting
behavior, and how you checked it. Include reproduction steps for a defect;
include before-and-after images or recordings when a UI change needs them.
Update tests and documentation when a behavior or operator workflow changes.

Use an imperative commit subject with a conventional type where it helps readers
scan the history, for example `fix: prevent duplicate session creation` or
`docs: clarify the rollback procedure`. Do not combine unrelated cleanup with a
behavioral change.

Before requesting review, run the focused checks for the affected code and any
required project checks. A typical full local gate is:

```bash
npm run verify
```

## Pull request review

A pull request should state its intent, link the relevant issue when one exists,
and call out compatibility, security, operational, or migration consequences.
Reviewers may request a smaller scope, tests, or documentation before merging.

## Releases and operations

Release installation, update, rollback, and service procedures live in
[docs/SELF-HOST.md](docs/SELF-HOST.md). Use an approved immutable commit SHA for
source-checkout updates rather than a moving branch:

```bash
./scripts/gajae-app.sh status
./scripts/gajae-app.sh update --ref <approved-full-commit-sha>
```

## Contribution terms

By submitting a contribution, you agree to the terms in [LICENSE](LICENSE) and,
for a first contribution, the [Contributor License Agreement](CLA.md). Read both
before opening a pull request.
