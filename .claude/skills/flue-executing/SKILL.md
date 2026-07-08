---
name: flue-executing
description: Execute a /flue-planning plan wave-by-wave for effect-flue and open a PR against main.
argument-hint: "[plan-path]"
---

# flue-executing

Execute a plan produced by `/flue-planning` wave-by-wave, verify against the live worker, and open a PR against `main`. Invoking this skill IS the approval to execute — there is no separate `APPROVED` state in v1.

This is v1 of the skill — deliberately lean. It gets sharpened by `/flue-postmortem` findings over future PRs.

## Stack (fixed)

- **Install:** `bun install`.
- **Verify:** `bun run typecheck`. There is NO lint script and NO test script today — do not attempt `bun run lint` or `bun run test`.
- **Deploy + live verification:** via `/flue-verifying` (deploy is `bun run deploy` — always the package script, never bare `wrangler deploy`, so predeploy builds the FE and uploads skills; requires Docker). Treat the repo `CLAUDE.md` "Commands" section as the command authority.
- **Base branch:** `origin/main`.
- **Plan status vocabulary (exact):** `DRAFT → IN_PROGRESS → PR_CREATED → POSTMORTEM_COMPLETE`.
- **Conventions:** merge commits only (never rebase/squash); never `--no-verify`; no `as` casts or `!` assertions; schema-first — types flow from Effect Schemas.

## Workflow

1. **Load the plan.** If a path was given as the argument, read it. Otherwise glob `~/c0de/plans/effect-flue/*.md`, filter to plans whose Status is `DRAFT` or `IN_PROGRESS`, and ask the user to pick one. Set Status → `IN_PROGRESS` when execution starts.
2. **Validate.** Task IDs are unique; no two tasks in the same wave touch the same file; every dependency references a task in an earlier wave. Stop and report if validation fails.
3. **Branch.** `git fetch origin main`, then create the feature branch named in the plan from `origin/main`. v1 keeps this simple — a plain branch, no worktree machinery yet (candidate future refinement).
4. **Execute wave-by-wave.** Complete every task in a wave before starting the next. Run `bun run typecheck` after each wave and fix failures before moving on. Commit once per wave with a conventional-commit message; never `--no-verify`.
5. **Verify before the PR.** If the diff has any runtime surface, run `/flue-verifying` (deploy + live-worker checks — e.g. `bun scripts/agent.ts <name> <id> --message "hi" --url <worker-url>`). Markdown/docs-only diffs may skip deploy.
6. **Open the PR.** Push the branch, then `gh pr create` against `main`. The body includes `Closes #N` when the plan closes an issue. Update the plan: Status → `PR_CREATED` and record a `> **PR:** <url>` line.
