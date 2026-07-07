---
name: flue-postmortem
description: Orchestration retrospective after a plan's PR is created — NOT a code review. Turns churn into concrete edits to the flue-* skills.
argument-hint: "[plan-path]"
---

# flue-postmortem

This is an orchestration retrospective, explicitly NOT a code review. Code findings belong in PR review and are never re-litigated here. The output of this skill is (a) concrete edits to the `flue-*` skills and (b) a short "how to set this up better next time" note. It runs PRE-merge, on plans with Status `PR_CREATED`; the post-merge step is `/flue-cleaning-up`.

## Steps

### 1. Load the plan

- If a plan path was passed as the argument, use it.
- Otherwise, glob `~/c0de/plans/effect-flue/*.md` and filter to plans with Status `PR_CREATED`.
- If multiple candidates match, ask the user which one. If none match, stop.

### 2. Gather churn signals

Look for friction in how the work was orchestrated, not in the code itself:

- User corrections and reversals in the conversation ("no, actually…", repeated re-explanations, rejected approaches).
- Fixup/revert commits on the branch: `git log main..<branch> --oneline` — commits that undo or patch earlier commits in the same plan.
- Plan-vs-shipped drift: compare the plan's task list against what actually landed. Tasks that were dropped, split, reordered, or invented mid-flight are churn.

### 3. Trace each churn point to a skill

For each churn point, ask: **which skill or gate would have prevented this?** The improvable suite is:

- `flue-planning`, `flue-executing`, `flue-creating-issues`, `flue-verifying`, `flue-cleaning-up`, `flue-postmortem` — all under `.claude/skills/`.

Propose a concrete edit to the specific `flue-*` SKILL.md (an added step, a new gate, a sharpened instruction — quote the proposed text). If no skill maps cleanly, note it as a "setup" finding instead.

### 4. Apply approved edits

Present the proposed edits to the user. Apply the approved ones directly to the skill files under `.claude/skills/`.

### 5. Close out

- Set the plan's Status to `POSTMORTEM_COMPLETE`.
- Offer to run `/flue-cleaning-up` once the PR merges.

## Why this skill matters

This skill is the mechanism by which the whole suite improves. v1 of every `flue-*` skill is deliberately thin; postmortem findings are how they grow. If a postmortem produces zero skill edits, look harder — or say explicitly why the run was clean.
