# Gajae Code App Design System

This document extracts the current product design system from `src/index.css` (which, since Tailwind 4, also carries the `@theme` aliases that used to live in `tailwind.config.js`), `src/shared/view/ui`, `src/components/app/AppContent.tsx`, the sidebar, and chat surfaces. It documents what exists today; it is not a redesign brief.

## 1. Atmosphere & Identity

Gajae Code App feels like a quiet local command center for coding agents: dense, warm, low-glare, and built for long-running supervision rather than marketing spectacle. The signature is a warm neutral shell with a sharp orange primary action color, compact rows, and glass-like navigation surfaces that keep the user's attention on live sessions, chat, and project context.

Primary personas:
- **Solo maintainer on desktop**: monitors multiple tmux-backed agents for hours, needs dense lists, stable scroll positions, and fast keyboard/mouse interaction.
- **Mobile observer**: checks running sessions from a phone or PWA, needs safe-area-aware controls, 44px touch targets where possible, and no pull-to-refresh accidents.
- **Korean/English bilingual user**: reads mixed Hangul, Latin code paths, and provider labels, so Pretendard is the default sans face and serif fallbacks must never create ugly Korean glyph substitution.
- **Keyboard and screen-reader user**: uses command palette, dialogs, tabs, sidebar actions, and chat controls through visible focus, ARIA state, semantic buttons/links, and predictable tab order.

## 2. Color

### Palette

All new product colors must route through semantic CSS variables in `src/index.css` and the `@theme` aliases in the same file. Existing status exceptions are recorded as debt in Section 8.

| Role | Token | Light | Dark | Usage |
|------|-------|-------|------|-------|
| App background | `--background` / `bg-background` | `44 22% 96%` | `0 0% 8%` | Fixed app shell, page background, focused nav controls |
| Primary text | `--foreground` / `text-foreground` | `36 25% 4%` | `40 8% 93%` | Body text, headings, active labels |
| Rail surface | `--sidebar` / `bg-sidebar` | `44 20% 93%` | `0 0% 6%` | The sidebar and the workspace panel: one tonal step below the stage, so the centre pane reads as the document without a hard divider |
| Card surface | `--card` / `bg-card` | `0 0% 100%` | `0 0% 12%` | Cards, prompt input, mobile drawer, elevated list rows |
| Card text | `--card-foreground` | `36 25% 4%` | `40 8% 93%` | Text on card surfaces |
| Popover surface | `--popover` / `bg-popover` | `0 0% 100%` | `0 0% 12%` | Dialogs, command result modal, popovers |
| Popover text | `--popover-foreground` | `36 25% 4%` | `40 8% 93%` | Text on popover surfaces |
| Primary action | `--primary` / `bg-primary` | `14 89% 52%` | `16 90% 57%` | Primary buttons, send button, focus ring, selected accents |
| Primary action text | `--primary-foreground` | `210 40% 98%` | `0 0% 8%` | Text/icons on primary action surfaces |
| Secondary surface | `--secondary` / `bg-secondary` | `44 15% 91%` | `0 0% 17%` | Secondary buttons, muted controls |
| Secondary text | `--secondary-foreground` | `36 15% 18%` | `40 8% 93%` | Text on secondary surfaces |
| Muted surface | `--muted` / `bg-muted` | `44 15% 91%` | `0 0% 17%` | Empty states, pills, rows, placeholder surfaces |
| Muted text | `--muted-foreground` | `40 5% 44%` | `0 0% 60%` | Captions, timestamps, hints, secondary metadata |
| Accent surface | `--accent` / `bg-accent` | `44 15% 91%` | `0 0% 17%` | Hover rows, ghost-button hover, selected command item |
| Accent text | `--accent-foreground` | `36 15% 18%` | `40 8% 93%` | Text on accent surfaces |
| Destructive | `--destructive` / `text-destructive` | `0 84.2% 60.2%` | `354 100% 65%` | Error text, destructive alerts, delete affordances when tokenized. Dark is the GJC TUI's `dangerRed` (`#ff4d5e`): the shadcn maroon read as text on a dark surface failed contrast |
| Destructive text | `--destructive-foreground` | `210 40% 98%` | `0 0% 8%` | Text/icons on destructive surfaces; dark on the light dark-mode red, as primary does |
| Border | `--border` / `border-border` | `44 14% 87%` | `0 0% 17%` | Dividers, card outlines, default borders |
| Input border | `--input` / `border-input` | `44 14% 87%` | `0 0% 23%` | Inputs and outline buttons |
| Focus ring | `--ring` / `ring-ring` | `14 89% 52%` | `16 90% 57%` | Focus rings and checkbox focus outline |

### Navigation and Mobile Tokens

| Role | Token | Light | Dark | Usage |
|------|-------|-------|------|-------|
| Glass nav surface | `--nav-glass-bg` | `44 22% 96% / 0.7` | `0 0% 12% / 0.55` | `.nav-glass` translucent navigation surfaces |
| Glass blur | `--nav-glass-blur` | `20px` | `24px` | Backdrop blur for nav glass |
| Glass saturation | `--nav-glass-saturate` | `1.8` | `1.6` | Backdrop saturation for nav glass |
| Floating nav shadow | `--nav-float-shadow` | `0 0% 0% / 0.06` | `0 0% 0% / 0.35` | `.mobile-nav-float` elevation |
| Floating nav ring | `--nav-float-ring` | `44 14% 87% / 0.5` | `0 0% 17% / 0.3` | `.mobile-nav-float` outline |
| Nav divider | `--nav-divider-color` | `44 14% 87% / 0.5` | `0 0% 17% / 0.5` | Gradient dividers |

### Rules

- Prefer semantic HSL variables through Tailwind classes: `bg-background`, `text-muted-foreground`, `border-border`, `bg-primary`, `text-destructive`.
- Use raw Tailwind status colors only for existing status semantics that have not been tokenized yet: emerald/green running, amber/yellow attention, and red destructive rows.
- New persistent colors require a named token in this section before use.

## 3. Typography

### Font Stack

- Primary sans: `"Pretendard Variable", Pretendard, "Encode Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`.
- Serif: `Merriweather, Georgia, Cambria, "Times New Roman", "Pretendard Variable", Pretendard, serif`; Korean falls through to Pretendard.
- Mono: Tailwind/system mono is used for keyboard hints, file paths, code, and JSON blocks.

### Scale

| Level | Class / Size | Weight | Line Height / Tracking | Usage |
|-------|--------------|--------|------------------------|-------|
| Landing H1 | `text-2xl sm:text-3xl` | `font-semibold` | `tracking-tight` | New-session greeting |
| App title | `text-sm` | `font-bold` | `tracking-tight` | Sidebar brand header |
| Section/card title | `text-base` or `text-sm` | `font-medium` / `font-semibold` | default or tight | Empty states and card titles |
| Body | `text-sm` | `font-normal` | default / `leading-6` in composer | Main row labels, chat input, messages |
| Secondary | `text-xs` | regular/medium/semibold by context | relaxed for snippets, uppercase tracking for labels | Metadata, counts, timestamps |
| Micro | `text-[0.6875rem]` (11px), `text-[10px]`, `text-[9px]`, `text-[8px]`, `text-[7px]` | regular to semibold | uppercase/tracking on provider/status micro-labels | Dense sidebar badges, command hints, running counts |
| Code/content | `font-mono text-xs`, prose code | regular | wraps aggressively in chat | Paths, JSON, code, and terminal output |

### Rules

- Body text should normally stay at `text-sm`; `text-xs` is reserved for dense metadata and controls.
- Mobile form fields use at least 16px when needed to avoid iOS zoom, as seen in mobile edit/select overrides.
- Preserve Pretendard loading before `index.css` in `src/main.jsx`.
- Use `truncate`, `break-words`, `whitespace-pre-wrap`, and `overflow-wrap` patterns for long paths, prompts, URLs, and chat messages.

## 4. Spacing & Layout

### Base Unit

The system uses Tailwind's 4px spacing scale. Existing values like `p-2`, `gap-2`, `px-3`, `py-2.5`, `h-10`, and `rounded-lg` should be read as design tokens, not arbitrary pixels.

| Token / Class | Value | Usage |
|---------------|-------|-------|
| `0.5` | 2px | Segmented control inset, tiny row spacing |
| `1` | 4px | Icon gaps, compact row groups, badges |
| `1.5` | 6px | Dense header and icon gaps |
| `2` | 8px | Standard compact padding, sidebar rows, chat groups |
| `2.5` | 10px | Sidebar header vertical rhythm |
| `3` | 12px | Sidebar shell padding, list cards, dialog internals |
| `4` | 16px | Main content gutters, prompt header, card padding |
| `5` | 20px | Reserved larger panel padding |
| `6` | 24px | Main desktop composer bottom, larger vertical rhythm |
| `8` | 32px | Empty-state and landing spacing |
| `12` | 48px | Empty-state vertical blocks |

### App Shell and Scroll Ownership

- Root shell: `fixed inset-0 flex bg-background` with `bottom: var(--keyboard-height, 0px)`.
- Document scroll is disabled; scroll belongs to explicit panes (`ScrollArea`, chat message pane, file/editor panes).
- Desktop sidebar: border-right rail, `md:w-72`, `md:px-1.5 md:py-2`, no document scroll.
- Mobile sidebar: overlay `fixed inset-0`, drawer `w-[85vw] max-w-sm sm:w-80`, backdrop `bg-background/60 backdrop-blur-sm`.
- Chat content width: `max-w-[54.25rem]` for messages and composer.
- New-session landing width: `max-w-[46rem]` with `pb-[10vh]` visual centering.
- Files side panel: `w-80 max-w-[85vw] md:w-72`.
- Tailwind container defaults: centered, `padding: 2rem`, `2xl: 1400px`.

### Safe Areas

- `--safe-area-inset-*` mirror `env(safe-area-inset-*)` with `constant()` fallback.
- Mobile nav dimensions are centralized through `--mobile-nav-height`, `--mobile-nav-padding`, and `--mobile-nav-total`.
- PWA mode applies safe-area padding to `#root` and adjusts `.fixed.inset-0` top/side edges.

## 5. Components

### Button

- **Structure**: `Button` is a `forwardRef` primitive with `class-variance-authority` variants.
- **Variants**: `default`, `destructive`, `outline`, `secondary`, `ghost`, `link`.
- **Sizes**: `default` `h-10 px-4 py-2`, `sm` `h-9 px-3`, `lg` `h-11 px-8`, `icon` `h-10 w-10`.
- **States**: hover/active colors per variant, `focus-visible:ring-1 ring-ring`, disabled opacity and pointer lock.
- **Accessibility**: native button semantics; icon-only buttons need `aria-label` or `title` at call sites.
- **Motion**: global 150ms color transition, active feedback where supplied.

### Input

- **Structure**: `Input` wraps native `input` with full width, `h-9`, rounded-md, tokenized border and transparent background.
- **States**: placeholder muted, focus-visible ring, disabled cursor/opacity.
- **Usage**: file tree, project wizard, command result modal.
- **Accessibility**: call sites must provide labels, placeholder is not a label.

### Card

- **Structure**: `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter`, `CardAction`.
- **Surface**: `rounded-xl border bg-card text-card-foreground shadow-sm`.
- **Spacing**: `p-4`, `space-y-1.5`, content/footer remove top padding.
- **Usage**: plan display and other reusable panel content.

### Badge and Alert

- **Badge**: compact `rounded-md border px-2.5 py-0.5 text-xs font-semibold`; variants mirror primary/secondary/destructive/outline.
- **Alert**: `role="alert"`, grid layout for optional icons, rounded-lg border, default or destructive tone.
- **Usage**: session counts, command modal metadata, confirmations, warning/error blocks.

### Dialog

- **Structure**: context-managed `Dialog`, `DialogTrigger`, `DialogContent`, `DialogTitle` rendered through `createPortal`.
- **Surface**: fixed black overlay `bg-black/50 backdrop-blur-sm`; content `rounded-xl border bg-popover shadow-lg`.
- **States**: controlled or uncontrolled open, Escape closes, outside click closes.
- **Accessibility**: `role="dialog"`, `aria-modal="true"`, focus trap, autofocus first focusable element, restore trigger focus on close.
- **Motion**: overlay/content 150ms show animations from Tailwind keyframes.

### Tooltip

- **Structure**: wrapper plus fixed-position portal; positions `top`, `bottom`, `left`, `right`.
- **Surface**: gray/white inverse rounded tooltip with small arrow and shadow.
- **Interaction**: hover delay defaults to 350ms; touch uses long press and outside pointer dismissal.
- **Debt**: current tooltip is mostly pointer/touch driven; keyboard/focus semantics are recorded in Section 8.

### Prompt Input

- **Structure**: compound form with `PromptInput`, header, body, textarea, footer, tools, button, submit.
- **Surface**: `rounded-2xl border border-border/60 bg-card shadow-md`, stronger shadow/ring on focus-within, optional `chat-input-expanded` elevation.
- **Spacing**: outer composer `px-2 pb-2 sm:px-4 sm:pb-4 md:pb-6`; input internals `px-3`, textarea `px-4 py-2`.
- **States**: ready/submitted/streaming/error status context, drag overlay, file attachment strip, command menu, queued draft, voice and token controls.
- **Accessibility**: native form, labelled submit actions, `dir="auto"` textarea for mixed-language input.

### ScrollArea

- **Structure**: outer `relative overflow-hidden`, inner scroll owner `h-full w-full overflow-auto rounded-[inherit]`.
- **Touch behavior**: `WebkitOverflowScrolling: touch` and `touchAction: pan-y`.
- **Usage**: sidebar content and file tree.

### Command Palette Primitives

- **Structure**: `cmdk` wrapper with input, list, empty state, group, item, separator.
- **Surface**: transparent input, border-b header, max 300px scroll list.
- **States**: `data-[selected=true]` maps to `bg-accent text-accent-foreground`; disabled locks pointer and opacity.

### Sidebar Rows and Header

- **Structure**: desktop and mobile share the same Codex-aligned hierarchy: product wordmark and global search, one `New task` action, an inline filter field (`h-8`, `bg-muted/60`, `type="search"`; `/` focuses it from outside any text field, Escape clears it) that narrows the tree by conversation title and message body while force-expanding matching projects, then independently collapsible `Projects` and `Work` sections. Project rows are not duplicated as session containers; Work owns the latest-first session list and identifies each row's project in secondary text.
- **Surface**: `bg-background`, borderless list rows, and restrained tonal hover/selected states.
- **States**: selected `bg-primary/5 border-primary/20`, starred yellow tint, destructive red actions. Each session row carries one derived status (`src/stores/sessionStatusModel.ts`): `running` shows the muted spinner in the age slot; `needs_input` a pulsing `bg-primary` leading dot plus a `text-primary` alert glyph; `blocked` a `bg-destructive` dot plus a `text-destructive` warning glyph; `ready` (finished, not yet opened) a solid `bg-primary` dot with the age left in place. Every indicator has `role="status"` and a translated `aria-label`. The Work heading shows non-zero per-state counts and project rows a `bg-primary/10` (or `bg-destructive/10` when a run failed) count of sessions that need a look; zero counts are never rendered.
- **Layout**: scroll ownership stays in `ScrollArea`; the wordmark/search header, primary action, and utility footer remain fixed. Archive recovery, refresh, issue reporting, community, and version remain compact footer utilities.

### Sidebar Primary Navigation

- **Structure**: a single icon-and-label `New task` row is the primary action. `Projects` and `Work` are section headings with native `aria-expanded` disclosure controls; the Projects heading also owns an adjacent labelled `+` action.
- **Actions**: `New task` starts a session for the selected project. With no selected project it opens project creation, avoiding a disabled primary action. Global search opens the existing command palette.
- **States**: section chevrons rotate when expanded, rows use tonal hover/selection, and project management actions appear on hover or keyboard focus.
- **Accessibility**: disclosure buttons expose `aria-expanded` and `aria-controls`; all icon-only actions have names and titles, and every control preserves a visible focus ring.
- **Responsive behavior**: desktop and mobile preserve the same information order and one scroll owner, with touch-sized primary rows on mobile.

### Chat Pane

- **Structure**: `ChatMessagesPane` owns scroll; `ChatComposer` is fixed at the bottom of the chat column.
- **Session tasks**: a collapsible, read-only task card sits above the transcript whenever the current session has a plan. Its progress stays visible when collapsed; the expanded list has a bounded, keyboard-focusable scroll area so long plans do not push the composer off screen. Tasks no longer occupy a workspace-panel tab.
- **Performance**: message rows use `contain`, `content-visibility: auto`, and intrinsic sizes to reduce long-transcript layout cost.
- **States**: loading, empty provider selection, older-message loaders, load-all overlay, grouped tool messages, new-message scroll button.
- **Layout**: message and composer width align at `max-w-[54.25rem]`.

### Archive Recovery

- **Structure**: archived projects and sessions render as compact grouped cards behind the sidebar header archive action.
- **States**: loading, recoverable error with retry, empty archive, restore project, restore session, and permanent delete.
- **Surface**: existing border-and-muted panel treatment with semantic destructive and restore colors already used by sidebar controls.

## 6. Motion & Interaction

### Timing

| Type | Duration / Easing | Usage |
|------|-------------------|-------|
| Instant reset | `transition: none` base on `*` before scoped rules | Prevent inherited accidental transitions |
| Micro hover | 100ms | Hover shortening for buttons, anchors, role buttons |
| Active press | 50ms | Active-state tap feedback |
| Standard controls | 150ms `cubic-bezier(0.4, 0, 0.2, 1)` | Buttons, transforms, focus outline/ring, modal show |
| Theme color | 200ms ease-in-out | Background, border, color transitions for non-interactive structural elements |
| Modal/dropdown | 200ms ease-in-out / standard bezier | Modal opacity/transform transitions |
| Sidebar overlay | 150ms ease-out mobile, 300ms sidebar utility | Mobile drawer and sidebar transitions |
| Message | 300ms | Chat message affordances |
| Shimmer | 1.6s linear infinite | The run's status label: a band of foreground light crossing dimmed text, on the text for the whole cycle. Exempt from `prefers-reduced-motion` (nothing moves; a single frame froze the band over the last letters) |
| Spinner | 1s linear infinite | Loading spinners |

### Rules

- Prefer transform, opacity, and filter for custom motion; existing height transitions are legacy and should not be expanded.
- Respect `prefers-reduced-motion: reduce`; global CSS reduces animation/transition duration to near-zero.
- Touch devices suppress hover-only effects and keep active press feedback.
- Long transcript performance uses containment and content visibility rather than removing UI affordances.

## 7. Depth & Surface

### Strategy

The current strategy is mixed but restrained: borders and tonal shifts for default structure, shadows for small elevated controls, dialogs, composer focus, and mobile overlays, plus glass treatment for navigation/backdrop layers.

| Level | Treatment | Usage |
|-------|-----------|-------|
| Base | `bg-background`, no shadow | App shell and main panes |
| Rail | `bg-sidebar` plus `border-border/50` edge | Sidebar (expanded and collapsed), workspace panel, their mobile drawers |
| Panel | border plus tonal opacity (`border-border/50`, `bg-card/50`, `bg-muted/40`) | Sidebar groups, archived cards, lists |
| Interactive row | tonal hover/selected states (`hover:bg-accent/50`, `bg-primary/5`) | Sidebar and command items |
| Elevated card | `rounded-xl border bg-card shadow-sm` | Shared `Card`, archived cards, small panels |
| Floating control | `shadow-sm`, `shadow-md`, rounded-full/rounded-xl | Scroll-to-bottom, prompt input, mobile actions |
| Modal/popover | overlay blur plus `shadow-lg` | Dialog, command/file dropdowns |
| Nav glass | `backdrop-filter: blur(...) saturate(...)` | Navigation glass and mobile overlays |

### Rules

- Do not add broad decorative shadows to dense operational panes.
- Preserve border/tonal hierarchy first; add shadows only for true elevation or focused/floating controls.
- If a surface needs glass, use the existing `--nav-*` tokens or add a named token first.

## 8. Accessibility Constraints & Accepted Debt

### Constraints

- Target WCAG 2.2 AA: 4.5:1 contrast for body-sized text and 3:1 for large text, icons, focus indicators, and meaningful UI boundaries.
- Every icon-only control must expose an accessible name through `aria-label`, visible text, or `title` where no better label exists.
- Dialogs must keep focus trapped, close on Escape, and restore focus to the opener.
- Tabbed controls must use `role="tablist"`, `role="tab"`, and `aria-selected` as shown in settings surfaces.
- Long-running and attention states must not rely on color alone; pair color with text, `role="status"`, accessible labels, or visible badges.
- Mobile controls should meet 44px touch targets when primary or frequently used; smaller dense controls need surrounding row hit areas or must remain secondary.
- Motion must respect `prefers-reduced-motion`; do not introduce unavoidable animation for critical information.
- Korean/English mixed text must stay legible in Pretendard and support `dir="auto"` where user-entered prose can be bidirectional.
- Scroll must stay inside explicit pane owners, preserving keyboard focus and avoiding document-level horizontal or vertical overflow.

### Accepted Debt

| Item | Location | Why accepted | Owner / Exit |
|------|----------|--------------|--------------|
| Legacy raw RGB/Tailwind colors for dark form controls, placeholders, status badges, and sidebar semantic states | `src/index.css`, sidebar rows | Existing product UI already relies on these colors; this task documents the system without changing visible styling. | Tokenize status/form colors in a dedicated visual consolidation pass. |
| Tooltip lacks full keyboard/focus tooltip semantics | `src/shared/view/ui/Tooltip.tsx` | Current tooltip supports hover, touch long press, and outside dismissal; changing behavior would alter product interaction. | Add focus-triggered display and ARIA association in a focused accessibility pass. |
| Some dense sidebar action controls are smaller than 44px | `src/components/sidebar/view/subcomponents/*` | Desktop density is central to the command-center feel; mobile rows provide larger surrounding hit areas for primary actions. | Audit primary mobile controls during visual QA and expand hit areas where actions are frequent or destructive. |
| No standalone primitive showcase exists yet | Project root / shared UI docs | Focused render harnesses and real-app breakpoint QA cover the sidebar tab primitive, but the project does not yet have a shared Storybook-style surface. | Expand the existing state harness into a reusable shared-primitive showcase during the next design-system consolidation pass. |
