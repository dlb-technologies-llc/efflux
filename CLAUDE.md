# effect-flue

A deployable Cloudflare agent runtime built from Effect v4 on native Workers bindings (`wrangler.jsonc`) — no framework required.

## Commands

Single source of truth — the `flue-*` skills defer here.

- `bun install` — install (Bun workspaces).
- `bun run typecheck` — runs `cf-typegen` first (regenerates the gitignored `worker-configuration.d.ts`), then `tsc --noEmit` across the three tsconfigs. There is NO lint or test script today.
- `bun run build` — FE build + API typecheck.
- `bun run deploy` — ALWAYS the package script, never bare `wrangler deploy`: only the script fires the `predeploy` hook (FE build + `bun scripts/upload-skills.ts`). Requires a local Docker daemon (builds the container image).
- `bun run dev` — `wrangler dev` (also needs Docker). `bun run tail` — stream Worker logs. `bun run cf-typegen` — `wrangler types`.
- Secrets: `wrangler secret put OPENROUTER_API_KEY` for the deployed Worker; `.dev.vars` locally (template: `.dev.vars.example`). `.dev.vars` must exist BEFORE `bun run typecheck` — the generated `Env` derives `OPENROUTER_API_KEY` from it.
- `bun scripts/agent.ts <name> <id> --message "..." [--url <worker-url>] [--model M] [--skill S] [--role R]` — live smoke CLI (`BASE_URL` env also works).

## Architecture

`wrangler.jsonc` declares everything: Worker `effect-flue` (entry `apps/api/src/index.ts`), DO bindings `AGENTS` (`Agent`) + `SANDBOX` (`Sandbox`, a container class built from `apps/api/container/Dockerfile`), R2 binding `SKILLS` (bucket `effect-flue-skills`), a daily cron, and FE assets from `apps/web/dist` (`run_worker_first` on `/agents/*` and `/tasks*`). Each `/agents/<name>/<id>` session routes to its own `Agent` DurableObject, which holds history, drives the model loop, and reaches the `Sandbox` container (Bash) plus R2 (skills/roles as `skills/<name>.md` / `roles/<name>.md`). Default model is `tencent/hy3:free` (testing tier — callers pass `model` per request for anything better). One `HttpApi` defined in `packages/shared` is used three ways: server handlers (`HttpApiBuilder`), a fully typed FE client (`HttpApiClient` in `apps/web`), and the SSE stream contract (`StreamPart` tagged union encoded/decoded on both sides).

## Conventions

- Schema-first: all types flow from Effect Schemas — no `as` casts, no `!` assertions, no parallel type definitions.
- Verification = deploy + hit the live worker (`/flue-verifying` checklist). Typecheck/build alone NEVER counts.
- Branch flow: feature PRs target `staging` with `Refs #N`; `/flue-releasing` promotes staging→main with a PR carrying the `Closes #N` lines (issues close on release, not on feature landing). Merge commits only — never rebase/squash. Never `--no-verify`.
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

Plans live in `~/c0de/plans/effect-flue/`; status vocabulary is `DRAFT → IN_PROGRESS → PR_CREATED → POSTMORTEM_COMPLETE`.

- `/flue-planning` — produce a wave-structured plan for a task; run before any nontrivial change.
- `/flue-executing` — run a plan's waves as parallel agents in an isolated worktree (`.claude/worktrees/<plan-name>`) and open the PR against `staging`.
- `/flue-creating-issues` — turn a rough problem statement into one well-formed `gh issue create`.
- `/flue-verifying` — the deploy-and-live-smoke checklist; run before any PR with a runtime surface.
- `/flue-postmortem` — pre-merge orchestration retrospective on a `PR_CREATED` plan; edits the `flue-*` skills.
- `/flue-cleaning-up` — post-merge: remove the plan's worktree, delete the local branch, and archive the plan (`POSTMORTEM_COMPLETE` plans).
- `/flue-releasing` — promote `staging`→`main` via a merge PR carrying the `Closes #N` lines, then tag + GitHub-release the merge; semver from 0.1.0, pre-1.0 rules (feat → minor, everything else → patch).
