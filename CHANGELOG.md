# Changelog

All notable changes to Efflux are recorded here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project follows
[Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-07-15

Scheduled-jobs release: cron scheduling plus the full manual lifecycle, session
tooling, and local-dev observability. Every headline feature in this release was
**live-validated against a running worker** (`/efflux-verifying`) before the
promotion — driven end-to-end through its real endpoint or tool with the actual
output captured, not merely green in CI.

### Added

- **Full cron-expression scheduling for scheduled jobs** (#121) — jobs run on a
  standard `* * * * *` cron schedule, dispatched from the `Agent` DO's alarm onto
  a per-job `Runner` container.
- **Manual "run now" trigger** (#126) — fire a scheduled job immediately through
  the same path the alarm uses, on a fresh `Runner`, returning that run's captured
  stdout/stderr and exit code; does not reschedule or change paused state.
- **Pause / resume a scheduled job** (#124) — stop a job firing while retaining
  all config, and resume it onto its existing schedule (missed slots are skipped,
  no catch-up fire). Both idempotent.
- **Full run-history view** (#129) — every retained run for a job, most recent
  first, each with its captured output (`GET …/schedule/:jobId/runs`).
- **`/feature-generating` skill** (#98) — author an automated feature from a
  plain-language request, test it live, then schedule it to run unattended.
- **Invoke uploaded skills via chat slash commands** (#108) — type `/skill`
  anywhere in the composer to apply a skill to a turn.
- **Per-tool session auto-approve control** (#110) — flip a tool's approval rule
  (`ask` / `allow` / `deny`) per session via `PUT …/config`.
- **Delete / rotate an individual stored secret** (#107) — full secrets CRUD
  (`PUT` upsert/rotate, `GET` list without values, idempotent `DELETE`).
- **Branded flux-mark loading spinner** (#116) — replaces the plain "Loading…"
  text with the animated `animate-flux` mark.
- **One-command local dev** (`bun run dev:local`, #117) — validates `.dev.vars`,
  inlines `VITE_API_TOKEN` into the FE build, and seeds the default skills/roles
  into local Miniflare R2 before `wrangler dev`.
- **OpenTelemetry tracing the Effect way** (#128) — a console exporter for local
  dev emits correlated spans across the HTTP, tool, and model-call layers.

### Changed

- Skill/documentation postmortem findings folded back into the `efflux-*` skills
  across the batch (#99, #109, #111, #112, #113, #118, #120, #123, #125, #127).

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
