# AGENTS.md

Guidance for coding agents working in this repository.

## What this is

Gajae Code App (`gajae-app`, v2.0.0-beta.x) — a self-hosted web + desktop UI for the GJC
coding agent. MIT. Four runtime layers:

- `src/` — React 19 SPA (Vite 7, Tailwind 4, react-router, i18next).
- `server/` — Express backend (`server/index.js` entry), SQLite via better-sqlite3,
  WebSocket, node-pty terminals. TypeScript + JS mixed, run through `tsx`.
- `native/gajae-core/` — Rust core, built to `dist-native/` by `scripts/build-rust-core.mjs`.
- `src-tauri/` — Tauri 2 desktop shell (Rust: `supervisor.rs`, `lifecycle.rs`,
  `navigation.rs`); packages the server as a payload and supervises it.

`shared/` is code shared between client and server (product identity, network hosts,
job projection protocol). `scripts/` holds build/release/verify tooling.

## Environment

- Node 22.22.2+ (22.x) or 24.15.0+ (24.x) — the test runner refuses other majors.
  On the primary Mac: `. "$HOME/.nvm/nvm.sh" && nvm use 22`.
- Rust/cargo required for `check:core`, `build:core*`, and the Tauri shell
  (`. "$HOME/.cargo/env"`).
- Bun **exactly 1.4.0** for `*.bun.test.ts` and `*.dom.bun.test.tsx` files (pinned in
  `scripts/fetch-bun.mjs`): `dist-native/bun` or PATH; fetch with
  `node scripts/fetch-bun.mjs`.
- `npm ci` applies the app-owned SDK lifecycle patch from
  `patches/gjc-sdk-lifecycle/manifest.json` through postinstall. Exact SDK/core/AI
  versions and complete before/after hashes are mandatory. Use
  `npm run apply:sdk-patch` / `npm run check:sdk-patch`; never hand-edit installed
  dependency files. Unknown local modifications must fail rather than be replaced.
- Server binds loopback by default (fail-closed; it can run shell commands).
  `SERVER_PORT` defaults to 3001, Vite dev on 5173. Do not export `SERVER_PORT=0`.
- Tauri builds choke on `CI=1`: use `env -u CI npm run tauri -- build`.
- Linux desktop packaging targets native `x86_64-unknown-linux-gnu`, bundles
  Node **22.22.2** and Bun **1.4.0**, and needs GTK 3/WebKitGTK 4.1 plus the
  prerequisites in `docs/DESKTOP-LINUX.md`. CI builds on Ubuntu 22.04/glibc 2.35;
  local Ubuntu 24.04/glibc 2.39 artifacts do not establish that compatibility floor.

## Commands

```bash
npm run dev              # server (tsx, :3001) + vite client (:5173); prebuilds rust core
npm test                 # all tests via scripts/run-tests.mjs (node:test + bun test)
npm run typecheck        # tsc on both tsconfig.json and server/tsconfig.json
npm run lint             # eslint src/ server/ shared/ scripts/ + configs
npm run check:core       # cargo fmt --check + clippy -D warnings + cargo test
npm run verify           # FULL GATE: audit + typecheck + check:core + test + lint + check:identity + build
npm run test:e2e:gjc     # 7 GJC wire/browser e2e tests (separate from npm test)
npm run desktop:dev      # Tauri dev shell
npm run server:payload:linux # Linux x64 payload + pinned runtimes
env -u CI npm run desktop:build:linux # payload + Tauri deb/AppImage + release/desktop staging
npm run smoke:packaged-server -- --linux-root <extracted-dir> # extracted deb or squashfs-root
npm run smoke:packaged-server -- --linux-root <extracted-dir> --data-survival
npm run smoke:packaged-server -- --linux-root <squashfs-root> --appimage-env # AppRun + real Python/gio terminal probes
```

Run a single test file (match the runner's env):

```bash
# server test (node:test via tsx)
TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --test server/gjc-worker.test.ts
# client test
TSX_TSCONFIG_PATH=tsconfig.json node --import tsx --test src/stores/useSessionStore.test.ts
# bun-runtime test (files named *.bun.test.ts)
dist-native/bun test server/gjc-sdk-contract.bun.test.ts
# component test with a real DOM (files named *.dom.bun.test.tsx)
dist-native/bun test src/shared/view/ui/ActionMenu.dom.bun.test.tsx
```

`npm test` has a `pretest` that builds the Rust core (debug); tests fail without it.

Linux desktop CI is `.github/workflows/desktop-linux.yml`: manual/PR/push-main
builds, with package smokes on Ubuntu 22.04 and 24.04. After the bundle build,
it runs `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` and
`cargo test --locked --manifest-path src-tauri/Cargo.toml`; `npm run verify`
does not cover these desktop shell checks. It only uploads build
artifacts; it does not publish or announce releases. Stage Linux packages as
`release/desktop/gajae-app-desktop-${package.version}-linux-x64.deb` and
`.AppImage`, each with `.sha256`. Extract outside the checkout before smoking
to prevent repository `node_modules` from masking missing bundled dependencies.
Keep standard smoke and `--data-survival` as separate invocations. Record
packaging, server smoke, and interactive GUI results separately.
`desktop:build:linux` restores the verified AppImage runtime after linuxdeploy
and before staging/checksums; preserve this step so ELF rewriting cannot break
the runtime manifest hashes.

## Frontend stack

React 19.2 + TypeScript 5.9 on Vite 7 with the React Compiler enabled
(babel-plugin-react-compiler via @vitejs/plugin-react - do not add manual
memoization for performance; the compiler owns it), function components and
hooks throughout.
Two legacy `.jsx` files remain (`src/main.jsx`, `src/contexts/ThemeContext.jsx`); everything else
is `.ts`/`.tsx`. Routing is react-router-dom 7.

- **The UI primitives are owned, not installed.** `src/shared/view/ui/` holds 19
  shadcn-shaped components (Button, Dialog, Collapsible, Command, Tooltip,
  ScrollArea, ActionMenu, ...) written in this repo. **There is no Radix
  dependency.** Reaching for one to get a primitive that already exists here is
  a regression, not a shortcut. `cmdk` backs the command palette, `lucide-react`
  supplies icons.
- **State**: server state lives in **TanStack Query** (projects/git/messages
  window caches; see `docs/plans/frontend-refactor.md` P1), shell UI state in
  **Zustand** (`src/stores/useAppShellStore.ts`, `usePaletteOpsStore.ts`).
  `src/stores/useSessionStore.ts` keeps realtime tails and the merge pipeline
  over the Query-backed message windows. Cross-cutting state lives in five
  contexts - WebSocket, Auth, Theme, Permission, SessionStatus.
- **Server state**: `ws` for live messages, `authenticatedFetch` REST behind
  TanStack Query for the rest. The provider's transcript on disk is the source
  of truth - there is no messages table in SQLite and messages are never
  cached in localStorage.
- **Styling**: Tailwind 4 (CSS-first: `@theme` and the `dark` custom variant
  live in `src/index.css`; there is no `tailwind.config.js`) with
  `@tailwindcss/typography`. `cn()` (`src/utils/cn.js`) is clsx +
  tailwind-merge; variants use class-variance-authority. Pretendard Variable is
  the sans stack and is also appended to the *serif* stack, because the Latin
  serif faces carry no Hangul and Korean would otherwise fall back to a system
  serif. Colors come from the semantic variables in `src/index.css`; see DESIGN.md.
- **Content rendering**: markdown is react-markdown with remark-gfm/remark-math
  and rehype-katex (KaTeX's CSS is imported in `src/main.jsx`), plus
  react-syntax-highlighter. **Raw HTML is not rendered**: there is no
  `rehype-raw` in the pipeline, which is also why no sanitizer is installed. Do
  not add one without the other. There is no embedded editor: the app has no
  file browser, git GUI or code editor, and file references open in the user's
  own editor through `POST /api/system/open-file`.
- **Testing**: client tests render with `renderToStaticMarkup` and assert on the
  HTML string, which cannot reach a hook, an event or an effect. Anything that
  needs one goes in a `*.dom.bun.test.tsx` file, which Bun runs with happy-dom
  registered by `scripts/bun-dom-preload.ts` and `@testing-library/react`
  available. The preload is scoped by file name on purpose: server contract
  suites must never get a `window`, or code branching on `typeof window` takes
  the browser path in a server test. Both API styles use `node:test`.
- **Bundle**: `vite.config.js` pins `manualChunks` by hand - vendor-react,
  vendor-markdown, vendor-syntax, vendor-icons, vendor-i18n, vendor-tools. A new
  heavy dependency belongs in one of those groups.
- The `build` block in `package.json` is electron-builder-shaped and no electron
  tooling is installed, but it is **not** dead weight: `npm run check:identity`
  asserts its `appId`, product name, executable name, artifact name, protocols
  and macOS bundle keys against `shared/productIdentity.js`. The desktop shell
  is Tauri 2.

## Architecture notes

- **GJC provider isolation**: GJC is the *only* provider routed through an isolated
  worker (`server/gjc-worker.ts` + `gjc-worker-client.ts`, protocol in
  `gjc-worker-protocol.ts`, Bun SDK adapter in `gjc-bun-sdk-adapter.ts` /
  `gjc-bun-sdk-events.ts`). Claude/Codex/Cursor/OpenCode keep their own paths.
  Contract: `server/GJC-LIVE-SPEC.md`. Prompts are passed via owner-readable temp
  file (`@file`), never on the process argv.
- **Backend module boundaries are lint-enforced**: `eslint-plugin-boundaries` rules in
  `eslint.config.js` govern imports between `server/modules/*`
  (assets/automation/database/notifications/projects/providers/websocket) and fail on
  unknown dependencies. Do not add cross-module imports that violate them.
- **Product identity is checked**: `npm run check:identity` verifies names/URLs/scheme
  against `shared/productIdentity.js`. Change identity constants there, nowhere else.
- **Design system**: all product colors route through semantic CSS variables in
  `src/index.css` + the `@theme` color aliases in the same file. See `DESIGN.md` before
  touching UI styling; do not hardcode palette values.
- **Bundled runtime manifest**: `server/gjc-runtime-manifest.json` is filled by
  `npm run fill:runtime-manifest` (runs automatically before dev/build:server).
  Schema 2 includes the native closure and the canonical SDK patch's post-hashes.
  Worker startup checks both and refuses mismatched/nested dependency instances.
  A verified SDK patch is source-integrity evidence, not proof of complete SDK
  quiescence; unrepresented streaming/extension work must still block restart.
  `shared/sdkLifecyclePolicy.json` owns the file-count bound used by the applier,
  worker and native payload/archive guard. After changing the canonical patch,
  reapply it through a clean install and explicitly regenerate tracked runtime
  hashes with `npm run fill:runtime-manifest -- --update` before verification;
  normal dev/build gates only check the manifest and do not bless changed hashes.
- **Browser archive security backport**: `patches/extract-zip-symlink-leaf/manifest.json`
  owns the exact extract-zip 2.0.1 upstream PR160 transform. Postinstall applies
  it; `npm run check:extract-zip-patch` verifies canonical source/package hashes
  and rejects nested, aliased or modified installations. Server/desktop staging
  must carry and verify this independent patch. Do not put it in the SDK32
  lifecycle manifest or hand-edit node_modules. Audit recognition is conditional
  on the actual patch and a current review, not an unconditional advisory skip.
  Its archive-only protection is not a sandbox against concurrent local writers.
- **Chat tool cards follow the runtime, not Claude**: `src/components/chat/tools/configs/toolConfigs.ts`
  is keyed by the tool's own lowercase name (`bash`, `read`, `edit`, `todo_write`), and
  its accessors read the runtime's parameter schema. `server/gjc-tool-configs.bun.test.ts`
  checks both halves against the live `@gajae-code/coding-agent` catalog, including which
  fields each accessor touches.

## Conventions

- Conventional Commits, enforced by commitlint (`@commitlint/config-conventional`,
  husky `commit-msg`) — imperative present tense, types:
  feat/fix/perf/refactor/docs/style/chore/ci/test/build/revert.
- Husky `pre-commit` runs lint-staged (eslint on staged src/server/shared/scripts).
- Commits are expected to pass `npm run verify` (the repo's promotion gate).
- **Git operations belong to the agent, not the human.** Staging, committing,
  pushing and opening PRs are the agent's job — finishing a change means it is
  committed and pushed, not left dirty in the worktree for someone else to
  handle. Do not ask permission to commit work you were asked to do; land it and
  report what landed. This includes finishing off work already in the worktree
  when asked to (fix its lint, commit it, push it).
- Other people work in this repository. Never revert, stash, `git checkout --`,
  `git clean` or commit over changes you did not make without being told to.
  When a file mixes your edit with someone else's, stage only your own hunks.
- Never commit platform/runtime artifacts: `dist-native/`,
  `src-tauri/{target,binaries,resources/server-payload}`, `.gjc-worktrees/`,
  `dist/`, `dist-server/`, `release/`.

## Key docs

- `docs/V2-SESSION-HANDOFF.md` — current project status and how to resume work.
- `docs/plans/frontend-refactor.md` — the client roadmap: what shipped, what is
  next, and the sequencing that must not be reordered.
- `docs/plans/local-studio-ui-adoption.md` — the UI/UX adoption plan, phases 1-5
  shipped.
- `server/GJC-LIVE-SPEC.md` — GJC provider/worker contract.
- `docs/DESKTOP-TAURI-VERIFICATION.md` — desktop packaging/verification (incl. the
  human-gated notarization step).
- `docs/DESKTOP-LINUX.md` — Linux x64 desktop prerequisites, package builds,
  installation, compatibility floor, and validation procedure.
- `docs/SELF-HOST.md`, `CONTRIBUTING.md` — install/update lifecycle and PR rules.
