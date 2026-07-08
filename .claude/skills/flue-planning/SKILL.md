---
name: flue-planning
description: Produce a wave-structured implementation plan for effect-flue that /flue-executing can run. Optimized for this repo's fixed stack (Bun + Effect v4 beta + Cloudflare Workers/DO/R2/Containers).
argument-hint: "<task description>"
---

# flue-planning

Produce a wave-structured plan that `/flue-executing` runs. The stack is fixed and known — do NOT run a detection dance (no probing for lint configs, test runners, or package managers). Bake decisions on the facts below and spend the planning budget on the actual task.

This is v1 of the skill — deliberately lean. It gets sharpened by `/flue-postmortem` findings over future PRs.

## Stack (fixed)

- **Runtime/PM:** Bun workspaces — `apps/api` (Cloudflare Worker: HttpApi + `Agent` DO-per-session + Container sandbox), `apps/web` (Vite + React chat FE), `packages/shared` (HttpApi contract + schemas; all types flow from Effect Schemas).
- **Verify:** `bun run typecheck` (chains `bun run cf-typegen` first, regenerating the gitignored `worker-configuration.d.ts`, then the three tsconfigs), `bun run build`. There is NO lint script and NO test script today — never plan a task around `bun run lint` or `bun run test`.
- **Deploy:** `bun run deploy` — ALWAYS the package script, never bare `wrangler deploy`: only the script fires the `predeploy` hook (FE build + skills upload), so the bare form can ship a stale `apps/web/dist`. Requires a local Docker daemon (container image). Local dev: `bun run dev` (also needs Docker). Logs: `bun run tail`. Treat the repo `CLAUDE.md` "Commands" section as the command authority.
- **Live smoke CLI:** `bun scripts/agent.ts <name> <id> --message "hi" [--url <worker-url>] [--model M] [--skill S] [--role R]` (or `BASE_URL` env).
- **Conventions:** base branch `main`; PRs that close issues use `Closes #N`; merge commits only (never rebase/squash); never `--no-verify`; no `as` casts or `!` assertions; schema-first — types flow from Effect Schemas; verification means deploy + hit the live worker, not typecheck/build alone.
- **Plans dir:** `~/c0de/plans/effect-flue/`.
- **Landmines:** `ISSUES.md` at repo root is the authority — consult it before planning anything that touches Worker boot, secrets, DO RPC boundaries, containers, or the tool loop.
- **Effect v4 beta (`4.0.0-beta.94`):** never specify Effect APIs from memory. Authority order: this codebase's existing usage → local pinned source repos listed in `~/.claude/subrepos.json` (the `effect-smol` entry covers v4 betas) → Context7 MCP.

## Process

1. **Research.** Codebase first — copy the local convention and cite `file:line` for every pattern a task relies on. Read `ISSUES.md` for landmines touching the plan's surface. Effect v4 APIs only from source, in the authority order above.
2. **Exemplar inventory.** If the issue or user cites a template ("like <existing setup X>"), enumerate X's FULL inventory during research and list every element you're omitting in the plan for the user to see. Silent scope cuts against a named exemplar are the #1 "that's not what I asked" rework source (a releasing skill was silently dropped from the skills-suite plan this way).
3. **Tracker check.** `gh issue list --state all --search "<surface>"` and `gh pr list --state all --search "<surface>"` — look for twins and in-flight work before drafting tasks.
4. **Draft.** Use the plan template: a `# Plan:` header with `> **Status:** DRAFT` and `> **Branch:**` lines, then waves of tasks, each task with `**Files:**` and `**Acceptance:**`. No two tasks in the same wave may touch the same file. Save to `~/c0de/plans/effect-flue/<plan-name>.md`.
5. **Devil's-advocate pass.** Spawn a critical-review agent on the draft before presenting; fold in valid findings.
6. **Present.** Show a summary with wave/task counts and ask whether to run `/flue-executing`.
