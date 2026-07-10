# @efflux/web — Efflux console

The Efflux chat/agent console: a Vite + React 19 SPA driven by `@effect/atom-react`, talking to the Worker through the typed `HttpApiClient` and the `StreamPart` SSE contract from `@efflux/shared`.

## Design system

The UI is **Tailwind v4 + shadcn/ui**, styled entirely from the Efflux brand tokens. The single source of truth is the `/efflux-branding` skill (`.claude/skills/efflux-branding/SKILL.md`) — palette, typography, spacing, components, voice. Never hardcode a hex or `rgba()` in a component; style through the tokens.

- **Tokens** live in `src/index.css`: shadcn semantic vars (`--background`, `--primary`, `--border`, …) plus brand extras (`--surface-2`, `--accent-ghost`, `--accent-line`, `--faint`, `--success`, `--warning`) mapped through `@theme inline` to utilities (`bg-surface-2`, `border-accent-line`, `text-faint`, `text-success`, …). Machine-emitted values (model IDs, token counts, costs, tool args, code) use `font-mono tabular-nums`.
- **Dark-first.** `:root` is light, `.dark` is dark (shadcn's `@custom-variant dark`). The app defaults to dark: `src/theme.ts`'s `themeAtom` + a pre-paint script in `index.html` stamp `.dark` on `<html>` unless the user stored `light`. Toggle via the TopBar button (`useTheme()`); the choice persists to `localStorage("efflux-theme")`.
- **Fonts** are self-hosted (no CDN — Cloudflare/CSP): Inter (`@fontsource-variable/inter`) for UI, JetBrains Mono (`@fontsource/jetbrains-mono`) for machine text.

## Shared primitives (`src/components/`)

Build on these; don't re-invent per surface:

| Primitive | Purpose |
|---|---|
| `Markdown` | Sanitized GFM (`react-markdown` + `remark-gfm` + `rehype-sanitize`) — the ONLY way to render model output. Never `dangerouslySetInnerHTML`. |
| `Message` | One render path for history + live turns (`variant: "user" \| "assistant"`, `content`, `streaming?`, `tools?`). |
| `ToolCallCard` | Schema-agnostic tool-call view (`ToolCallView`): mono header, exit-status pill, collapsible output well. |
| `StatusPill` | Mono status/metadata badge (`state`, `label`, `dot?`). |
| `AsyncBoundary` | Wraps an `AsyncResult` → Skeleton / actionable `Alert`+Retry (`errorCopy`) / children / empty. |
| `AppShell` | Slot-based frame (`sessions`, `main`, `inspector`, `topBarActions?`) — owns the TopBar + responsive grid. Never imports a panel. |

Panels (`Chat`, `SessionSwitcher`, `ApprovalCards`, `JournalTimeline`, `ToolsPanel`, `SkillsPanel`) are **propless** and self-drive off atoms (`src/session.ts`, `src/atoms/`). `App.tsx` composes them into `AppShell` slots by element.

## Conventions

- Schema-first; no `as` casts, no `!` assertions (biome enforces `noNonNullAssertion`). Generated `src/components/ui/*` (shadcn) are exempt and biome-ignored.
- `exactOptionalPropertyTypes`: build optional props with `{ ...(x !== undefined ? { k: x } : {}) }`.
- JSDoc on declarations only — no inline `//`. Every animation honors `motion-reduce`; every control has a visible `focus-visible` ring.

## Adding a shadcn component

`bunx shadcn@latest add <name>` (config in `components.json`; alias `@/*` → `./src/*`). It writes to `src/components/ui/`. If it imports `next-themes`, rewrite it to take a `theme` prop (we drive theming from `themeAtom`, not next-themes).

## Scripts

`bun run dev` (proxies `/agents`, `/skills`, `/tasks`, `/meta` to `:8787`) · `bun run build` (`tsc --noEmit && vite build`) · `bun run typecheck`.
