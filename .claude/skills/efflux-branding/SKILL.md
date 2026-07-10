---
name: efflux-branding
description: The Efflux visual identity and design system — palette, typography, spacing, components, voice. The single source of truth for all UI/UX work; the Tailwind theme and shadcn/ui tokens derive from this file. Invoke before touching any frontend surface. Project-local to effect-flue/efflux; unrelated to the global brand-guidelines PDF generator.
argument-hint: "[component or surface you're styling]"
---

# Efflux — Brand Guidelines v1

The identity for the agent runtime (renamed `effect-flue` → **Efflux**). Dark-first, technical, restrained — modeled on the OpenRouter register. This file is the authority; the Tailwind theme (`apps/web`) and shadcn/ui token layer MUST mirror the values below, never diverge from them.

**Visual reference:** the brand board renders every token and component live → https://claude.ai/code/artifact/fa7d55d2-dfcd-4033-975b-7882b6b01d42

## The name

**Efflux** — *(physics: the act of flowing outward; the streaming out of particles, energy, or a current from a source)*. It descends from the old name (`flue`), reads as infra-grade, and names exactly what the product does: stream agent output from the edge. Tagline: **"Effect-native agents, streamed from the edge."**

- Wordmark: lowercase `efflux` in the UI chrome; `Efflux` in prose/headings.
- Never hyphenate or camelCase. Package scope becomes `@efflux/*`.

## First principles

1. **Dark is the default, light is real.** Ship both; light gets equal QA, never a naive invert.
2. **The machine speaks monospace.** Anything the runtime emits — model IDs, token counts, session IDs, costs, code, tool args — is `--font-mono` with `tabular-nums`. Human prose is `--font-sans`.
3. **One accent.** Cyan is the only brand hue. Semantic colors (success/warning/danger) encode *state* and are never used decoratively.
4. **State reads at a glance.** Encode status in form — a pill, a rail node, a border — not color alone.
5. **DRY.** Every value is a token. No literal hex in components; no re-declared borders. One source, this file.

## Design tokens

Authoritative CSS custom properties. Dark is the base (`:root`); light overrides under `@media (prefers-color-scheme: light)` and `[data-theme]`.

### Neutrals (cool-tinted — grey biased toward the accent)

| Token | Dark | Light | Use |
|---|---|---|---|
| `--bg` | `#0A0C0F` | `#FBFCFD` | app ground |
| `--bg-subtle` | `#0E1218` | `#F2F6F8` | striped rows, code wells |
| `--surface` | `#12161C` | `#FFFFFF` | cards, panels |
| `--surface-2` | `#171C23` | `#F5F8FA` | inputs, bars, secondary |
| `--surface-3` | `#1E242C` | `#EBF1F4` | hover / elevated / shadcn `--accent` bg |
| `--border` | `#242B34` | `#E2E8EC` | 1px dividers |
| `--border-strong` | `#333C47` | `#CBD5DB` | emphasized edges |
| `--text` | `#E8EEF3` | `#0C1116` | primary text |
| `--text-muted` | `#93A0AD` | `#55636E` | secondary text |
| `--text-faint` | `#64707C` | `#8A97A1` | captions, disabled |

### Accent — Efflux cyan

| Token | Dark | Light | Use |
|---|---|---|---|
| `--accent` | `#28D7E5` | `#0E9DB0` | primary action, links, focus ring |
| `--accent-bright` | `#62E9F2` | `#12B6CC` | hover |
| `--accent-dim` | `#1BA9B8` | `#0B8090` | labels, timeline rails, eyebrows |
| `--accent-contrast` | `#04141A` | `#FFFFFF` | text/icon on an accent fill |
| `--accent-ghost` | `rgba(40,215,229,.12)` | `rgba(14,157,176,.10)` | tints, selected fills |
| `--accent-line` | `rgba(40,215,229,.30)` | `rgba(14,157,176,.28)` | tinted borders |

### Semantic — state only

| Token | Dark | Light | Meaning |
|---|---|---|---|
| `--success` | `#3DD68C` | `#17915E` | approved, exit 0, complete |
| `--warning` | `#F5B544` | `#B3760A` | approval pending, degraded |
| `--danger` | `#F76D6D` | `#C64141` | error, deny, exit ≠ 0 |

Each pairs with a `-ghost` fill at ~12–14% alpha for backgrounds.

### Radius, shadow, motion

| Token | Value | Use |
|---|---|---|
| `--radius-sm` | `7px` | buttons, inputs, chips |
| `--radius` | `10px` | tool cards, wells, pills' containers |
| `--radius-lg` | `14px` | primary cards, the console |
| `--shadow` | `0 1px 2px rgba(0,0,0,.45), 0 12px 32px rgba(0,0,0,.35)` (dark) | elevated cards only — use sparingly |

Motion is functional: streaming pulse, focus ring, 150ms hover transitions. No decorative animation. Always honor `prefers-reduced-motion`.

## Typography

- **UI / prose:** **Inter** — `--font-sans: 'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`.
- **Machine / code:** **JetBrains Mono** — `--font-mono: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace`.
- Self-host both (no CDN — Cloudflare app). Subset to used weights.

| Role | Font | Size | Weight | Tracking |
|---|---|---|---|---|
| Display | Inter | `clamp(2.4rem,5vw,3.4rem)` | 680 | -3% |
| H1 | Inter | 1.6–1.7rem | 620 | -2% |
| H2 | Inter | 1.2rem | 600 | -1% |
| Body | Inter | 0.95–1rem / 1.6 | 400 | 0 |
| Small | Inter | 0.82rem | 400 | 0 |
| Label | mono | 0.72rem | 500 | +8–16% uppercase |
| Mono/data | JetBrains | 0.78–0.85rem | 500 | 0, `tabular-nums` |

Keep running prose ≤ ~68ch. Headings get `text-wrap: balance`.

## Component rules

- **Buttons.** `primary` (accent fill, `--accent-contrast` text), `secondary` (surface-2 + `--border-strong`), `ghost` (transparent → surface-2 hover), `danger` (danger-ghost fill). Radius `--radius-sm`. Always a visible `:focus-visible` ring (`--accent`).
- **Pills / badges.** Mono, `--radius` full (999px), 0.72rem. Status pills carry a leading dot; `streaming` pulses. Model IDs and token counts are neutral mono pills.
- **Cards.** `--surface` + 1px `--border`, `--radius-lg`. Shadow only when floating above content (the console, popovers).
- **Tool-call card.** A bordered block with a mono header (`▾` caret · tool name in accent · args muted · exit-status pill), a labeled `Output` well on `--bg-subtle`, `overflow-x: auto`. Collapsible. This replaces today's raw dumps.
- **Markdown (assistant messages).** The current #1 gap — messages render as plain `pre-wrap` text today. Render real markdown: `strong` heavier + full-contrast, `h3/h4` with tight tracking, `ul/ol` with accent `::marker`, inline `code` in a mono chip (surface-2 + border, accent text), fenced `pre` in a `--bg-subtle` well with `overflow-x: auto`, links underlined with `--accent-line`. Use a sanitizing renderer (e.g. `react-markdown` + `remark-gfm`); never `dangerouslySetInnerHTML` on model output.
- **Journal / timeline.** A typed timeline: a rail with a colored node per event (accent = model turn, success = ok tool, danger = failed), title + mono meta, right-aligned per-turn cost in `tabular-nums`. Order is meaningful — numbering/rail is information, not decoration.
- **Approval card.** `--warning` left border (3px) + warning-ghost fill, the command in a mono well, `Approve` (primary) / `Deny` (danger) actions.
- **Composer.** Surface input, accent focus ring + `--accent-ghost` glow. Placeholder shows the send shortcut.
- **Scroll.** The chat transcript owns its own scroll region (the current build has none). Rails scroll independently. The page body never scrolls sideways — wide content gets its own `overflow-x: auto`.

## shadcn/ui token mapping

shadcn semantic vars map to Efflux tokens as below. **Note:** shadcn's `--accent` is a *subtle hover/selected background*, NOT the brand accent — the brand accent maps to `--primary`.

| shadcn var | Efflux token (dark) | shadcn var | Efflux token (dark) |
|---|---|---|---|
| `--background` | `--bg` `#0A0C0F` | `--secondary` | `--surface-2` `#171C23` |
| `--foreground` | `--text` `#E8EEF3` | `--muted` | `--surface-2` |
| `--card` | `--surface` `#12161C` | `--muted-foreground` | `--text-muted` `#93A0AD` |
| `--card-foreground` | `--text` | `--accent` | `--surface-3` `#1E242C` |
| `--popover` | `--surface-2` | `--accent-foreground` | `--text` |
| `--primary` | `--accent` `#28D7E5` | `--destructive` | `--danger` `#F76D6D` |
| `--primary-foreground` | `--accent-contrast` `#04141A` | `--border` / `--input` | `--border` `#242B34` |
| `--ring` | `--accent` | `--radius` | `0.625rem` (10px) |

## Voice & tone

Technical, precise, low-ceremony. Active voice. Name things by what people recognize, not how the system is built.

- **Precise, not chatty.** "Session archived." — no filler, no exclamation marks, no emoji in product copy.
- **Controls name outcomes.** The button says what happens; the toast confirms in the same words ("Archive" → "Archived").
- **Errors are actionable.** What broke, then how to fix it: *"Model refused the toolkit. Pin `openai/gpt-4o-mini`."* Never a raw stack or a shrug.

## Do / Don't

- ✅ Reference tokens; ❌ never literal hex or `rgba(127,127,127,…)` in a component.
- ✅ Mono for anything machine-emitted; ❌ never mono for human prose.
- ✅ One accent hue; ❌ never repurpose semantic colors as decoration.
- ✅ Render + sanitize markdown; ❌ never `dangerouslySetInnerHTML` on model output.
- ✅ Give the transcript its own scroll; ❌ never let the page body scroll sideways.
