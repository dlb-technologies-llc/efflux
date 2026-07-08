---
name: flue-cleaning-up
description: Remove a plan's worktree and local branch after its PR merges and archive the plan file. Post-merge step, runs after /flue-postmortem.
argument-hint: "[plan-path]"
---

# flue-cleaning-up

Purpose: remove the plan's worktree and local branch after its PR merges, then archive the plan.

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
- If the plan has NO `> **PR:**` line (manually merged / PR-less plan), skip the merge-status check and ask the user directly in Step 3.

### 3. Confirm with the user

`AskUserQuestion` — "PR is <MERGED|OPEN>. Clean up worktree and local branch?": "Yes, clean up" / "Skip". (Omit the PR status from the text if there was no PR metadata.) On "Skip", display "Cleanup skipped." and exit.

### 4. Remove the worktree

1. **Worktree name** = plan name (filename without `.md`, or from `# Plan:`), lowercase-hyphenated → `.claude/worktrees/<plan-name>`.
2. Confirm it exists:
   ```bash
   git worktree list --porcelain | grep "worktree.*/.claude/worktrees/<plan-name>$"
   ```
   If absent (pre-worktree-era plan, or already removed), note that, run `git worktree prune` anyway (a crashed cleanup can leave a pruned-directory-but-listed entry that blocks `git branch -d` with "checked out at <path>"), and continue to branch cleanup.
   If LISTED but the directory no longer exists on disk, `git worktree prune` clears the stale entry — then continue to branch cleanup.
3. Dirty check:
   ```bash
   git -C .claude/worktrees/<plan-name> status --porcelain
   ```
   If dirty, `AskUserQuestion` — "Worktree has uncommitted changes. Force remove?": "Force remove" / "Keep". On "Keep", exit without any cleanup.
4. Remove — **NOT `git worktree remove`**: it (and `move`) is blocked by the in-tree `.claude/effect-smol` submodule. Detach first (frees the branch for deletion), then delete the directory, then prune:
   ```bash
   git -C .claude/worktrees/<plan-name> checkout --detach
   rm -rf .claude/worktrees/<plan-name>
   git worktree prune
   ```
   (The detach happens INSIDE the worktree — the never-checkout rule applies to the main checkout only.)

### 5. Clean up the branch and archive the plan

- Identify the feature branch from the plan (or `gh pr view <n> --json headRefName`).
- The `checkout --detach` above already freed the branch (git refuses to delete a branch checked out in a live worktree). Do NOT switch branches in the main checkout to do this — no `git checkout` there, ever.
- Delete the local branch: `git branch -d <branch>` — only ever `-d`, never `-D`, so any unmerged work is protected by git itself. Ordering is load-bearing: the delete runs BEFORE `git fetch --prune` because `-d` accepts a branch as merged based on the (soon-to-be-pruned) `origin/<branch>` remote-tracking ref — local `main` is never updated by this flow (no checkout).
- Prune stale remote refs: `git fetch --prune`.
- Archive the plan: move the plan file to `~/c0de/plans/effect-flue/done/` (create the directory if it doesn't exist).

## Done

Report:

```
Cleanup complete: <plan-name>
Worktree: <removed | already removed | kept (uncommitted changes)>
Branch: <deleted | not found>
Plan: archived to ~/c0de/plans/effect-flue/done/<plan-name>.md
```

## Edge cases

1. Worktree already removed → skip worktree removal, still attempt branch cleanup.
2. Branch already deleted → note it, still archive the plan.
3. Dirty worktree + "Keep" → exit without any cleanup, reporting `Worktree: kept (uncommitted changes)`.
4. `git branch -d` refuses (unmerged) → report; never escalate to `-D` without the user's explicit say-so.
