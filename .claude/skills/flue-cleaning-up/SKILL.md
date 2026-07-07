---
name: flue-cleaning-up
description: Remove the local branch after a plan's PR merges and archive the plan file. Post-merge step, runs after /flue-postmortem.
argument-hint: "[plan-path]"
---

# flue-cleaning-up

Purpose: remove the local branch after a plan's PR merges, then archive the plan.

Lifecycle position: `/flue-postmortem` runs PRE-merge on plans with Status `PR_CREATED`. This skill is the POST-merge step and only auto-targets plans with Status `POSTMORTEM_COMPLETE`.

## Steps

### 1. Identify the plan

- If a plan path was passed as the argument, use it.
- Otherwise, glob `~/c0de/plans/effect-flue/*.md` and filter to plans with Status `POSTMORTEM_COMPLETE`.
- If multiple candidates match, list them and ask the user to pick one. Never guess.
- If none match, stop and tell the user — the plan may still need `/flue-postmortem` first.

### 2. Check merge status

- Extract the PR number from the plan's `> **PR:**` line.
- Run `gh pr view <n> --json state` and confirm `state` is `MERGED`.
- If the PR is not merged, stop. Cleanup only happens after merge.

### 3. Confirm with the user

Before deleting anything, show what will happen (branch to delete, plan file to move, any worktree to remove) and get explicit confirmation.

### 4. Clean up

- Identify the feature branch from the plan (or `gh pr view <n> --json headRefName`).
- Switch to `main` if currently on the feature branch: `git checkout main && git pull --ff-only`.
- Delete the local branch: `git branch -d <branch>` — only ever `-d`, never `-D`, so any unmerged work is protected by git itself.
- Prune stale remote refs: `git fetch --prune`.
- Archive the plan: move the plan file to `~/c0de/plans/effect-flue/done/` (create the directory if it doesn't exist).

### 5. Conditional: worktree removal

If a git worktree exists for this plan's branch (`git worktree list`), remove it with `git worktree remove <path>`. The v1 executor (`/flue-executing`) uses plain feature branches, not worktrees, so this usually no-ops — but it keeps this skill valid if a future executor adopts worktrees.

## Done

Report what was deleted/moved: branch name, plan's new path under `done/`, and any worktree removed.
