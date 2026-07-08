---
name: flue-executing
description: Execute a /flue-planning plan with wave-based parallel agents in an isolated worktree, then open a PR against main.
argument-hint: "[plan-path]"
---

# flue-executing

Execute a plan produced by `/flue-planning` with wave-based parallel agents in an isolated worktree, verify against the live worker, and open a PR against `main`. Invoking this skill IS the approval to execute — there is no separate `APPROVED` state.

This skill gets sharpened by `/flue-postmortem` findings over future PRs.

## NEVER checkout in the main working copy (hard rule)

**Do NOT run `git checkout`, `git switch`, or `git checkout -b` in the main repo checkout — ever.** It switches the *shared* checkout's branch and corrupts sibling agents/worktrees that are mid-task (there is routinely more than one `.claude/worktrees/*` in flight — concurrent sessions run on this repo). ALL execution happens inside a `git worktree` (Step 3) and is addressed with `git -C <WORKTREE_PATH> …`. The main checkout's branch is never changed by this flow — not to create the branch, not to commit, not to push. If you catch yourself typing `git checkout`, stop: use the worktree.

## Stack (fixed)

- **Install:** `bun install`.
- **Verify:** `bun run typecheck`. There is NO lint script and NO test script today — do not attempt `bun run lint` or `bun run test`.
- **Deploy + live verification:** via `/flue-verifying`, run FROM the worktree (`cd <WORKTREE_PATH>`). The canonical deploy is `bun run deploy` (never bare `wrangler deploy` — only the script fires the predeploy FE build + skills upload; requires Docker); if a PreToolUse hook blocks it, run its exact steps instead per the `/flue-verifying` fallback (`bun run build && bun scripts/upload-skills.ts && bunx wrangler deploy`). ⚠️ ALL sessions share ONE deployed worker — deploys race and last deploy wins; redeploy before smoking if another session may have deployed since. Treat the repo `CLAUDE.md` "Commands" section as the command authority.
- **Base branch:** `origin/main`. **Worktree task agent:** `flue-task-executor`.
- **Plan status vocabulary (exact):** `DRAFT → IN_PROGRESS → PR_CREATED → POSTMORTEM_COMPLETE`.
- **Conventions:** merge commits only (never rebase/squash); never `--no-verify`; no `as` casts or `!` assertions; schema-first — types flow from Effect Schemas.
- **Effect API truth:** the pinned `.claude/effect-smol` submodule (`packages/effect/src`, incl. `unstable/http`, `unstable/httpapi`) — never from memory and never via the `effect-agent` subagent (it reads a machine-global, unpinned checkout). Scope "existing usage" greps to `apps/ packages/`; reach into `.claude/effect-smol` deliberately.

## Workflow

### Step 1: Load the plan

If a path was given as the argument, read it. Otherwise glob `~/c0de/plans/effect-flue/*.md`, filter to plans whose Status is `DRAFT` or `IN_PROGRESS`, and ask the user to pick one. Set Status → `IN_PROGRESS` when execution starts.

### Step 2: Validate

Task IDs are unique; no two tasks in the same wave touch the same file; every dependency references a task in an earlier wave. Stop and report if validation fails.

### Step 3: Create Worktree

1. Branch name from plan metadata (`> **Branch:**`); worktree name = plan name (lowercase-hyphenated).
2. Resolve base:
   ```bash
   git fetch origin main
   ```
   `BASE_BRANCH=origin/main`.

   **Unmerged-branch base:** if the plan's `> **Base:**` is an open PR branch (the work amends an unmerged PR), or the target files don't exist on `origin/main` yet, set `BASE_BRANCH` to that branch's ref (`git fetch origin <branch>` → `origin/<branch>`). The work then folds into the open PR: REUSE that PR's branch — `git worktree add .claude/worktrees/<plan-name> <branch>` (no `-b`; `-b` errors on an existing branch) — so Step 6 finds the existing PR instead of opening a new one. If a new branch is genuinely needed off the unmerged base, its PR targets THAT branch, never `main` (a `main`-based PR would drag in the other PR's commits). Still a worktree — never a main-copy checkout.
3. **Stale-leftover check first:** if `.claude/worktrees/<plan-name>` already exists on disk, `git worktree add` will refuse — and `git worktree remove` can't clear it (submodule block). Confirm with the user it's a dead leftover, then `rm -rf .claude/worktrees/<plan-name> && git worktree prune` before adding.

   Create the worktree **from BASE_BRANCH** (never from the current branch, and never by checking out a branch in the main copy; only `git worktree add`), set HTTPS push, disable auto-gc:
   ```bash
   git worktree add .claude/worktrees/<plan-name> -b <branch-name> <BASE_BRANCH>
   CUR_URL=$(git remote get-url origin); REPO_URL=$(gh repo view --json url -q .url)
   [ -n "$REPO_URL" ] && [ "$CUR_URL" != "$REPO_URL" ] && git -C .claude/worktrees/<plan-name> remote set-url origin "$REPO_URL"
   git -C .claude/worktrees/<plan-name> config gc.auto 0
   ```
   If the branch already exists, verify it's based on BASE_BRANCH, then reuse it with `git worktree add .claude/worktrees/<plan-name> <branch-name>` (no `-b`). Note `gc.auto 0` also writes the shared `.git/config` (repo-wide, intentional — auto-gc mid-run can prune objects sibling worktrees are still writing); it's cheap to leave set.

   ⚠️ **Guard the `set-url` substitution (a worktree's remote config is REPO-SHARED).** `git remote` config lives in the shared `.git/config`, not per-worktree — running `remote set-url origin ""` (e.g. when `gh` transiently 401s and the substitution comes back empty) **wipes origin for the main checkout and every sibling worktree at once**. Hence the `[ -n "$REPO_URL" ]` guard above; if it skips, fall back to `git -C <main-checkout> remote get-url origin` and verify non-empty before setting.
4. Install deps (subshell — steps 5–8 assume the repo-root cwd):
   ```bash
   (cd .claude/worktrees/<plan-name> && bun install)
   ```
5. Copy local secrets — **REQUIRED, not best-effort**: the generated `Env` derives `OPENROUTER_API_KEY` from `.dev.vars`, so `bun run typecheck` FAILS in a worktree that lacks it:
   ```bash
   cp .dev.vars .claude/worktrees/<plan-name>/.dev.vars
   ```
   If the main checkout has no `.dev.vars`, STOP and have the user create it from `.dev.vars.example` — don't proceed to a guaranteed-broken typecheck.
6. **Init the pinned Effect submodule** — a fresh worktree has an empty `.claude/effect-smol`, which silently breaks the Effect-API-truth lookup:
   ```bash
   git -C .claude/worktrees/<plan-name> submodule update --init .claude/effect-smol
   ```
   If the fetch fails (pinned SHA unavailable), see the pin-fetch procedure in `CLAUDE.md` ("Bumping the `effect` version") — the `git ls-remote --tags` + `fetch --depth 1 origin <sha>` steps retrieve it directly.
7. **Materialize the generated Worker types** — `worker-configuration.d.ts` is gitignored, so a fresh worktree lacks it. The central `bun run typecheck` regenerates it (chains `cf-typegen`), but a task agent running bare `tsc`/`bunx tsc --noEmit` first would HALT on a missing-type-definition error *before* type analysis and report a **false green**. Generate it up front:
   ```bash
   (cd .claude/worktrees/<plan-name> && bun run cf-typegen)
   ```
8. Verify the plan's target files exist in the worktree — **only files the plan MODIFIES; skip files it explicitly CREATES**:
   ```bash
   for f in <files-to-modify>; do [ -f ".claude/worktrees/<plan-name>/$f" ] || echo "MISSING: $f"; done
   ```
   If any are missing, `AskUserQuestion`: "Use unmerged branch as base" (the files live on an open PR branch — recreate the worktree from `origin/<that-branch>`) / "Fix paths" / "Continue anyway" / "Abort".
9. Store the **absolute** worktree path as `WORKTREE_PATH`.

```
Creating worktree: .claude/worktrees/<plan-name> (branch: <branch>, base: <BASE_BRANCH>)
Installing dependencies (bun install)...
```

**Do NOT use the `EnterWorktree` tool** — it has path-confusion / stale-lock bugs. Use raw `git worktree add`.

**Create the worktree at its FINAL path directly** — `git worktree move` (and `remove`) are blocked by the in-tree `.claude/effect-smol` submodule, so a misplaced worktree can't be relocated; disposal (in `/flue-cleaning-up`) is `checkout --detach` + `rm -rf` + `git worktree prune`.

### Step 4: Execute Waves

For each wave:

**1. Announce:** `━━━ WAVE <N>: <count> tasks in parallel ━━━`

**2. Spawn parallel agents — launch ALL tasks for a wave in a SINGLE message with multiple Task calls**, each `subagent_type: "flue-task-executor"`. Prompt structure, in order:

1. **WORKTREE_PATH block** (below).
2. Task ID + description.
3. **The full task body, verbatim** — `**Files:**`, `**Acceptance:**`, and any inlined pattern / `**Do not:**` content. Sub-agents read their prompt reliably but referenced files unreliably — the prompt must be self-contained.
4. **Files to modify** — the ONLY files the agent may touch.
5. **Context** — brief summary of what previous waves produced.

WORKTREE_PATH block (every prompt):
```
WORKTREE_PATH: <absolute-path>

CRITICAL: All file paths are relative to the worktree. Prepend WORKTREE_PATH to every
Read/Write/Edit/Glob/Grep path. `apps/api/src/x.ts` → `<WORKTREE_PATH>/apps/api/src/x.ts`.
Do NOT run whole-tree git ops (`git reset`, `git checkout .`, `git add -A`, `git stash`) —
sibling agents share this worktree. Do NOT run `bun run typecheck` or deploy —
`/flue-executing` runs those centrally after the wave.
```

**3. Wait for all agents to complete.**

**4. Run verification centrally:**

```bash
cd <WORKTREE_PATH> && bun run typecheck
```

Fix failures before moving on.

**4b. Post-wave compliance check** — sub-agent self-audits are unreliable; grep the wave's changed `.ts`/`.tsx` files centrally:

```bash
# modified AND newly created files — task agents stage nothing, so `diff HEAD` alone misses created files:
git -C <WORKTREE_PATH> diff --name-only HEAD -- '*.ts' '*.tsx'
git -C <WORKTREE_PATH> ls-files --others --exclude-standard -- '*.ts' '*.tsx'
# per file, excluding import/export-from lines (import aliases are legit `as`):
grep -vE '^\s*(import|export .* from)' <file> | grep -nE '\bas (const\b|[A-Za-z_])|[^!=]!(\.|\))'
```

The pattern must be `\bas (const\b|[A-Za-z_])`, NOT `as [A-Z]` — an uppercase-only pattern misses `as const` and lowercase casts. Hits inside comments or string literals ("as long as", "known as") are false positives — read the line before "fixing" it. Also grep each task's own `**Do not:**` bullets (the backticked code shapes) across the files that task changed. On a real hit: fix it, re-run typecheck. If unfixable, `AskUserQuestion`: proceed / abort.

**5. Commit the wave:**

Before any `git -C <WORKTREE_PATH> add -A`, scan `git -C <WORKTREE_PATH> status --porcelain` for unexpected untracked directories (embedded git repos, generated artifacts) — an embedded repo once got committed this way. Then:

Immediately before every commit, confirm `git -C <WORKTREE_PATH> branch --show-current` prints the plan branch — the one-line guard against the wrong-branch trap. Then:

```bash
git -C <WORKTREE_PATH> add -A
git -C <WORKTREE_PATH> commit -m "feat(<plan-name>): complete wave <N>

Completed:
- <task-id>: <description>"
```

Conventional-commit message; never `--no-verify`. Behavior-critical refactors get their OWN commit, separate from cosmetic changes, so the branch bisects. Check off completed tasks `- [x]` in the plan, continue.

If a task agent fails: capture its output, `AskUserQuestion`: "Retry task" / "Skip task" / "Abort".

### Step 5: Verify before the PR

If the diff has any runtime surface, run `/flue-verifying` from the worktree (`cd <WORKTREE_PATH>` — deploy + live-worker checks, e.g. `bun scripts/agent.ts <name> <id> --message "hi" --url <worker-url>`). Markdown/docs-only diffs may skip deploy. Remember: ALL sessions share the single live worker — deploys race (last deploy wins), so don't overlap another plan's deploy, and redeploy before smoking if another session may have deployed since.

### Step 6: Open the PR

1. Existing PR? `gh pr list --head <branch> --json number,url` — if found, skip to updating the plan file.
2. No commits vs `<BASE_BRANCH>` → skip the PR and notify the user.
3. Push from the worktree: `git -C <WORKTREE_PATH> push -u origin <branch>`.
4. `cd <WORKTREE_PATH> && gh pr create` against `main`. The body includes `Closes #N` when the plan closes an issue. The self-contained rule extends here: no other project/client/codebase named in commit messages or the PR body.
5. Update the plan: Status → `PR_CREATED` and record a `> **PR:** <url>` line — edit ONLY the header block with an anchored edit (status strings like `DRAFT` can legitimately appear inside task bodies; a global replace once corrupted a plan).
6. Display the PR URL and the worktree path — the worktree stays alive until `/flue-cleaning-up` removes it post-merge.
