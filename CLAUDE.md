# effect-flue

A deployable Cloudflare agent runtime built from Effect v4 on native Workers bindings (`wrangler.jsonc`) — no framework required.

## Commands

Single source of truth — the `flue-*` skills defer here.

- `bun install` — install (Bun workspaces).
- `bun run typecheck` — runs `cf-typegen` first (regenerates the gitignored `worker-configuration.d.ts`), then `tsc --noEmit` across the three tsconfigs. There is NO lint or test script today.
- `bun run build` — FE build + API typecheck.
- `bun run deploy` — ALWAYS the package script, never bare `wrangler deploy`: only the script fires the `predeploy` hook (FE build + `bun scripts/upload-skills.ts`). Requires a local Docker daemon (builds the container image).
- `bun run dev` — `wrangler dev` (also needs Docker). `bun run tail` — stream Worker logs. `bun run cf-typegen` — `wrangler types`.
- Secrets: `wrangler secret put OPENROUTER_API_KEY` for the deployed Worker; `.dev.vars` locally (template: `.dev.vars.example`).
- `bun scripts/agent.ts <name> <id> --message "..." [--url <worker-url>] [--model M] [--skill S] [--role R]` — live smoke CLI (`BASE_URL` env also works).

## Architecture

`wrangler.jsonc` declares everything: Worker `effect-flue` (entry `apps/api/src/index.ts`), DO bindings `AGENTS` (`Agent`) + `SANDBOX` (`Sandbox`, a container class built from `apps/api/container/Dockerfile`), R2 binding `SKILLS` (bucket `effect-flue-skills`), a daily cron, and FE assets from `apps/web/dist` (`run_worker_first` on `/agents/*` and `/tasks*`). Each `/agents/<name>/<id>` session routes to its own `Agent` DurableObject, which holds history, drives the model loop, and reaches the `Sandbox` container (Bash) plus R2 (skills/roles as `skills/<name>.md` / `roles/<name>.md`). Default model is `tencent/hy3:free` (testing tier — callers pass `model` per request for anything better). One `HttpApi` defined in `packages/shared` is used three ways: server handlers (`HttpApiBuilder`), a fully typed FE client (`HttpApiClient` in `apps/web`), and the SSE stream contract (`StreamPart` tagged union encoded/decoded on both sides).

## Conventions

- Schema-first: all types flow from Effect Schemas — no `as` casts, no `!` assertions, no parallel type definitions.
- Verification = deploy + hit the live worker (`/flue-verifying` checklist). Typecheck/build alone NEVER counts.
- Base branch `main`. PRs that close issues use `Closes #N`. Merge commits only — never rebase/squash. Never `--no-verify`.
- Effect v4 beta (`4.0.0-beta.66`): never write Effect APIs from memory. Authority order: this codebase's existing usage → pinned source repos in `~/.claude/subrepos.json` (`effect-smol` covers v4 betas) → Context7 MCP.

## Landmines

Read `ISSUES.md` at the repo root BEFORE touching Worker boot, secrets, DO RPC boundaries, containers, or the tool loop. It is the authority on known traps.

## Skills

Plans live in `~/c0de/plans/effect-flue/`; status vocabulary is `DRAFT → IN_PROGRESS → PR_CREATED → POSTMORTEM_COMPLETE`.

- `/flue-planning` — produce a wave-structured plan for a task; run before any nontrivial change.
- `/flue-executing` — run a plan wave-by-wave on a feature branch and open the PR against `main`.
- `/flue-creating-issues` — turn a rough problem statement into one well-formed `gh issue create`.
- `/flue-verifying` — the deploy-and-live-smoke checklist; run before any PR with a runtime surface.
- `/flue-postmortem` — pre-merge orchestration retrospective on a `PR_CREATED` plan; edits the `flue-*` skills.
- `/flue-cleaning-up` — post-merge: delete the local branch and archive the plan (`POSTMORTEM_COMPLETE` plans).
- `/flue-releasing` — every merge to main is tagged + GitHub-released; semver from 0.1.0, pre-1.0 rules (feat → minor, everything else → patch).
