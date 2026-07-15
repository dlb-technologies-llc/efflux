# efflux

A deployable Cloudflare agent runtime built from Effect v4 on native Workers bindings (`wrangler.jsonc`) — no framework required.

## Commands

Single source of truth — the `efflux-*` skills defer here.

- `bun install` — install (Bun workspaces).
- `bun run typecheck` — runs `cf-typegen` first (regenerates the gitignored `worker-configuration.d.ts`), then `tsc --noEmit` across the six tsconfigs (`packages/shared`, `apps/api`, `apps/web`, `apps/tui`, `scripts`, `apps/api/container`). `bun run test` (vitest) and `bun run lint` (`biome check .`) also exist and are CI-gated (`.github/workflows/ci.yml` runs typecheck + test + lint with `bun install --frozen-lockfile` on every PR).
- `bun run build` — FE build + API typecheck.
- `bun run deploy` — ALWAYS the package script, never bare `wrangler deploy`: only the script fires the `predeploy` hook (FE build + `bun scripts/upload-skills.ts`). Requires a local Docker daemon (builds the container image).
- `bun run dev` — `wrangler dev` (also needs Docker). `bun run tail` — stream Worker logs. `bun run cf-typegen` — `wrangler types`.
- Secrets: `wrangler secret put OPENROUTER_API_KEY` (model calls) + `API_TOKEN` (the Authorization bearer; the FE's `VITE_API_TOKEN` is inlined at build time and must match) + `SECRETS_ENCRYPTION_KEY` (AES-GCM key for session-stored secrets, `apps/api/src/SecretsCrypto.ts`) for the deployed Worker; `.dev.vars` locally (template: `.dev.vars.example`). `.dev.vars` must exist BEFORE `bun run typecheck` — the generated `Env` derives its keys from it.
- First-time deploy provisioning (once per account): `wrangler r2 bucket create efflux-skills` + `efflux-sessions`, `wrangler ai-search create efflux-knowledge --type builtin`, then the secrets above. Deployed at `https://efflux.david-0e2.workers.dev`. A renamed `remote: true` binding (e.g. `ai_search`) blocks `wrangler dev` until its instance exists — see `ISSUES.md`.
- `bun scripts/agent.ts <name> <id> --message "..." [--url <worker-url>] [--model M] [--skill S] [--role R]` — live smoke CLI (`BASE_URL` env also works).
- `bun run openai-smoke <name> <id> [--url <worker-url>]` — stock OpenAI-SDK smoke: configures the session (`openai/gpt-4o-mini`, `Bash:allow`), then drives a tool-using conversation (non-stream + stream) through the `/v1` facade and confirms the session in `GET /v1/models`.

## Architecture

`wrangler.jsonc` declares everything: Worker `efflux` (entry `apps/api/src/index.ts`), DO bindings `AGENTS` (`Agent`) + `SANDBOX` (`Sandbox`, a container class built from `apps/api/container/Dockerfile`) + `RUNNER` (`Runner`, a second container class on the same image, for unattended scheduled-job execution) + `REGISTRY` (`Registry`, the singleton session index), R2 bindings `SKILLS` (bucket `efflux-skills`) + `SESSIONS` (bucket `efflux-sessions`, per-session workspace tarballs plus per-scheduled-job promoted snapshots), a daily cron, and FE assets from `apps/web/dist` (`run_worker_first` on the API prefixes `/agents`, `/tasks`, `/skills`, `/v1`, `/knowledge`, `/meta`). Each `/agents/<name>/<id>` session routes to its own `Agent` DurableObject, which holds the append-only event journal (DO SQLite), the sandbox exec/hydrate seam, encrypted session secrets, and any scheduled jobs (dispatched from the DO's own alarm onto a per-job `Runner` instance — see the `/feature-generating` skill); the Worker handler (`handlers.ts`) — NOT the DO — drives the hop-capped model loop and reaches the `Sandbox` container (Bash) plus R2 (skills/roles as `skills/<name>.md` / `roles/<name>.md`). Beyond Bash, the session toolkit also exposes the external MCP-client tools, the AI-Search `search_knowledge` tool, the journal-backed todo tools, and the secret/scheduling tools (`has_secret`/`request_secret`/`create_scheduled_job`), and sessions carry per-session config (model/rules/TTL/thresholds/mcpServers) with automatic context compaction. Default model is `tencent/hy3:free` (testing tier — callers pass `model` per request for anything better). One `HttpApi` defined in `packages/shared` is used three ways: server handlers (`HttpApiBuilder`), a fully typed FE client (`HttpApiClient` in `apps/web`), and the SSE stream contract (`StreamPart` tagged union encoded/decoded on both sides).

## Conventions

- Schema-first: all types flow from Effect Schemas — no `as` casts, no `!` assertions, no parallel type definitions.
- Testing: `@effect/vitest` (`import { describe, expect, it } from "@effect/vitest"`; `import { Effect, Schema } from "effect"`), run by root `bun run test` (CI-gated). Schema-derived arbitraries are the DEFAULT test data — `Schema.toArbitrary(<Schema>)` (there is NO `Arbitrary` module at beta.94 and `Arbitrary.make` does NOT exist), fed to `it.effect.prop("name", [arb], ([v]) => Effect.gen(…), { fastCheck: { numRuns: 100 } })`. Round-trip codecs assert `Schema.encodeEffect`/`Schema.decodeEffect` (stable re-encode) inside `Effect.gen`; sync `Schema.encodeSync`/`Schema.decodeUnknownSync` for non-effect pins. `FastCheck` and `TestClock` come from `effect/testing` (`import { FastCheck } from "effect/testing"`) — reach for raw `FastCheck.*` (e.g. `FastCheck.constantFrom`) ONLY for genuine one-offs no schema backs. NEVER `Schema.toArbitrary` a regex-refined schema — the generator exhausts FastCheck's `.filter`; pin fixed representative values round-tripped via `it.effect`, or use codec-clean schemas. Exemplars: `packages/shared/src/Schemas.test.ts` (prop + pins), `apps/api/src/AttachStream.test.ts` (TestClock + totality pins), `packages/shared/src/OpenAi.test.ts` (FastCheck one-off).
- Generated `apps/web/src/components/ui/*` (shadcn/ui) are EXEMPT from the no-`as`/no-`!` rule and are excluded from biome linting; ALL hand-written code still obeys no-`as`/no-`!`.
- FE design system: `apps/web` is Tailwind v4 + shadcn/ui driven by the `/efflux-branding` tokens (dark-first, cyan accent, self-hosted Inter + JetBrains Mono). Invoke `/efflux-branding` before any frontend work — it is the palette / typography / component source of truth, mirrored into `apps/web/src/index.css`.
- Verification = exercised against a running worker (`/efflux-verifying` checklist) — typecheck/build alone NEVER counts, but **local `bun run dev` is the default, the deployed worker is for the single final pre-PR pass only.** `wrangler dev` runs Containers entirely through the local Docker daemon — Cloudflare's own docs describe no scenario where it reaches remote infrastructure — so local iteration is free. Every deploy is real, billed Container usage shared across every session on this account; deploying repeatedly to debug (instead of reproducing locally) is how a routine PR turned into a real bill (see ISSUES.md).
- Branch flow: feature PRs target `staging` with `Refs #N`; `/efflux-releasing` promotes staging→main with a PR carrying the `Closes #N` lines (issues close on release, not on feature landing). Merge commits only — never rebase/squash. Never `--no-verify`.
- Effect v4 beta (`4.0.0-beta.94`): never write Effect APIs from memory. Authority order: this codebase's existing usage (grep scoped to `apps/ packages/`) → the pinned `.claude/effect-smol` submodule (`packages/effect/src` — core incl. `unstable/http`, `unstable/httpapi`; init once with `git submodule update --init .claude/effect-smol`) → Context7 MCP. Read the submodule directly — do NOT spawn the `effect-agent` subagent (it reads a machine-global, unpinned checkout). The repo-local `.claude/subrepos.json` records the pin (`pinned` field) and the submodule's `src`/`test` search globs.
- Bumping the `effect` version means bumping EVERY pin location — package.json in all workspaces, the submodule gitlink, `.claude/subrepos.json` `pinned`, and prose literals in CLAUDE.md + `.claude/skills/`:
  ```
  git ls-remote --tags https://github.com/Effect-TS/effect-smol.git "refs/tags/effect@<ver>^{}"   # → <sha>
  git -C .claude/effect-smol fetch --depth 1 origin <sha> && git -C .claude/effect-smol checkout <sha>
  git add .claude/effect-smol
  # then update .claude/subrepos.json "pinned", and grep -rn "beta\.<old>" CLAUDE.md .claude/skills/ for prose literals
  ```

## Landmines

Read `ISSUES.md` at the repo root BEFORE touching Worker boot, secrets, DO RPC boundaries, containers, or the tool loop. It is the authority on known traps.

## Skills

Plans live in `~/c0de/plans/efflux/`; status vocabulary is `DRAFT → IN_PROGRESS → PR_CREATED → POSTMORTEM_COMPLETE`.

- `/efflux-planning` — produce a wave-structured plan for a task; run before any nontrivial change.
- `/efflux-executing` — run a plan's waves as parallel agents in an isolated worktree (`.claude/worktrees/<plan-name>`) and open the PR against `staging`.
- `/efflux-creating-issues` — turn a rough problem statement into one well-formed `gh issue create`.
- `/efflux-verifying` — the deploy-and-live-smoke checklist; run before any PR with a runtime surface.
- `/efflux-postmortem` — pre-merge orchestration retrospective on a `PR_CREATED` plan; edits the `efflux-*` skills.
- `/efflux-cleaning-up` — post-merge: remove the plan's worktree, delete the local branch, and archive the plan (`POSTMORTEM_COMPLETE` plans).
- `/efflux-releasing` — promote `staging`→`main` via a merge PR carrying the `Closes #N` lines, then tag + GitHub-release the merge; semver from 0.1.0, pre-1.0 rules (feat → minor, everything else → patch).
- `/efflux-branding` — the Efflux visual identity / design system (palette, typography, spacing, components, voice); the single source of truth for any frontend surface, mirrored into `apps/web/src/index.css`. Invoke before touching any UI/UX.
