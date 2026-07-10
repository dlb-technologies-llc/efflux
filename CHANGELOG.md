# Changelog

All notable changes to Efflux are recorded here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project follows
[Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-07-10

First stable release. Efflux is a deployable Cloudflare agent runtime built on
Effect v4 and native Workers bindings — no framework required.

### Highlights

- **Agent runtime.** Per-session `Agent` Durable Objects with an append-only
  event journal (DO SQLite), a `Sandbox` container (Bash + `/workspace`),
  R2-backed skills and roles, a singleton `Registry` session index, and a
  Worker-side hop-capped tool loop over OpenRouter models. One `HttpApi` defined
  in `packages/shared` serves the Worker handlers, a fully typed web client, and
  the SSE `StreamPart` stream contract.
- **Session toolkit & compaction.** Beyond Bash, each session exposes
  journal-backed todo tools (`todo_write`), external MCP-server tools (per-session
  `mcpServers` config), and an AI-Search `search_knowledge` tool — with automatic
  context compaction that folds older turns into a running summary as the journal
  grows.
- **Session lifecycle.** Reset, archive, or purge a session (the `DELETE`
  endpoint's `mode` query); archived journals persist to `efflux-sessions` as an
  eval corpus, and an idle-TTL alarm reaps stale sessions.
- **HTTP surface.** Bearer-token auth guards every endpoint; an OpenAI-compatible
  `/v1` facade (`/v1/chat/completions` + `/v1/models`) fronts the runtime; live
  turns survive disconnects via stream reattach (`GET /attach` with
  `Last-Event-ID`); and knowledge documents upload through `PUT /knowledge/:name`.
- **Web console (Tailwind v4 + shadcn/ui).** A dark-first agent console driven by
  the `/efflux-branding` design tokens: sanitized rendered markdown, collapsible
  tool-call cards, a scrolling transcript with a pinned composer, a free-entry
  model combobox, a Skills dialog, and a Journal/Tools inspector — built on shared
  primitives (`Markdown`, `ToolCallCard`, `StatusPill`, `Message`,
  `AsyncBoundary`, `AppShell`) with self-hosted Inter + JetBrains Mono.
- **Design system.** The `/efflux-branding` skill is the single source of truth
  for the brand — palette, typography, tokens, component rules, and voice —
  mirrored into the Tailwind theme and the shadcn token layer.
- **Terminal client.** An Ink TUI that shares the typed client and SSE decoder.
- **Deployed on Cloudflare** — Worker `efflux`, R2 buckets `efflux-skills` and
  `efflux-sessions`, AI Search instance `efflux-knowledge`, and a daily cron.
- **CI** gates `typecheck` + `test` (vitest) + `lint` (biome) on every pull
  request.
