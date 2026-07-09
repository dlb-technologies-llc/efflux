---
name: flue-postmortem
description: Orchestration retrospective after a plan's PR is created — NOT a code review. Turns churn into concrete flue-* skill edits, landed as their own PR, plus a saved report.
argument-hint: "[plan-path]"
---

# flue-postmortem — orchestration retrospective

**This is NOT a code review.** Code-level findings were fixed in the PR at review time and are never re-litigated here. The postmortem looks ONLY at the **orchestration**: how the work was set up and run, where it churned, and **why** — willing to conclude that the issue's framing or the user's own prompt pointed the work the wrong way. Its output is (a) concrete edits to the `flue-*` skills, landed as their **own PR**, and (b) a saved report. Runs on plans with Status `PR_CREATED` (pre- or post-merge); the cleanup step is `/flue-cleaning-up`.

## Steps

### 1. Load the plan

- If a plan path was passed as the argument, use it.
- Otherwise glob `~/c0de/plans/effect-flue/*.md`, read each `> **Status:**`, filter to `PR_CREATED`; if multiple, `AskUserQuestion` to select. If none match, stop.

### 1.5. Re-sync `origin/staging` first (parallel-agent dedup)

`git fetch origin staging`. Concurrent sessions run on this repo, so the skills this postmortem might tighten are a moving target — another session's postmortem may have already landed the same fix. Before proposing any fix, diff it against the CURRENT `origin/staging` copy (`git show origin/staging:.claude/skills/<skill>/SKILL.md`; `git log <plan-base>..origin/staging -- .claude/`): if the lesson already landed, **drop it from the report** (note it as "already landed in #<pr>") — never re-recommend or re-apply it. If the run reproduced an anti-pattern a newer skill already forbids, THAT is the finding (root cause = "branched stale / didn't pull staging").

### 2. Gather orchestration signals (not a code scorecard)

Do not grade per-line code correctness — that was the reviewer's job. Gather process signals:

- **Churn from the conversation** — where did the user or agent retry, reverse a decision, re-scope, or change approach? Every reversal/correction is a signal. For each, ask what would have prevented it: a question up front, a clearer plan, a tighter gate, a better-framed issue.
- **Commit pattern** — fixup/revert/rework commits (`git log <base>..<branch> --oneline`) indicate the work was hazier than planned. Count corrections vs net-new commits.
- **Gate verdicts** — for each task that carried an inlined pattern / `**Do not:**`, did the produced work match the gate's *intent*? DRIFTED (pattern ambiguous → tighten `/flue-planning`'s inlined block); forbidden-list incomplete (→ tighten the authority it's copied from); pattern correct but the sub-agent ignored it (→ tighten `/flue-executing`'s post-wave grep or the executor self-audit).
- **Scope signal** — plan's listed files vs files actually touched. A large delta means over/under-scoping → tighten scoping in `/flue-planning`.

### 3. Root-cause the churn — upstream is fair game

For each churn point ask **why**, blame-neutral, and point upstream where the leverage is: did the issue's framing mislead the work? did the user's prompt set the wrong direction or change mid-flight (a cross-cutting decision settled twice because it wasn't pinned at kickoff)? did a skill or gate fail to catch it? State it plainly — "the naming convention wasn't pinned up front, so it was settled twice; fix = `/flue-planning` elicits cross-cutting policy at kickoff." Don't bury an upstream root cause as "the implementation fell short."

### 4. Write the report

Save to `~/c0de/plans/effect-flue/postmortems/<plan-name>-postmortem.md` (`mkdir -p` first):

```markdown
# Postmortem: <plan-name> — orchestration retrospective

> **Plan:** `~/c0de/plans/effect-flue/<plan>.md`
> **PR:** #<n> (<url>)   |   **Branch:** `<branch>`   |   **Date:** <date>

## What churned (and why)

| Churn / reversal / re-scope | Root cause (incl. upstream: issue framing / prompt / gate) |
|---|---|

(If the run was smooth — few corrections, no reversals — say so: "Clean run, no material churn.")

## Gate verdicts (skill feedback loop)

| Task | Gate (pattern / forbidden) | Held / Drifted / Violated | Why | Skill to tighten |
|---|---|---|---|---|

(If all gates held: "All gates held — the inlined patterns worked as designed." That's the success signal.)

## Scope signal

<Planned vs actual files: over/under-scoped? → tighten `/flue-planning`? Or "proportional — no signal.">

## Orchestration fixes (the output)

- [ ] `.claude/skills/<skill>/SKILL.md` — <what to tighten, and why>
- [ ] GitHub issue (project-specific root cause only) — <title + why>

## How to set this up better next time

<Concrete: what to ask up front, how to frame the issue, which gate to add.>

---
*No code-level findings appear here by design — those were fixed in the PR at review time.*
```

### 5. Present findings

`AskUserQuestion` — "Here's the orchestration read. How to proceed?" Give definitive, self-contained options and ALWAYS include an explicit decline:

- **"Apply the fixes"** — go to Step 6.
- **"Add / correct context first"** — free text → fold into the report (especially upstream root causes only the user knows), then apply.
- **"No — don't apply any fixes"** — first-class, expected: save the report as-is, skip Step 6. A correct read isn't always worth a skill change.

### 6. Apply the fixes — in a WORKTREE, as their own PR (never the main copy)

The output IS skill edits — apply them, don't leave them loose in the main checkout. Per `/flue-executing`'s **never-checkout-in-the-main-copy** hard rule, land them via a `git worktree`:

```bash
git fetch origin staging
git worktree add .claude/worktrees/postmortem-skill-fixes -b chore/postmortem-<plan-name> origin/staging
```

Skills are markdown — skip `bun install`/submodule/`.dev.vars`/`cf-typegen`; no typecheck needed. Edit the `.claude/skills/<skill>/SKILL.md` files IN the worktree, commit, push, and open a PR against `staging` with `Refs #N` — a clear title (`chore(skills): <plan-name> postmortem findings`) and a body that lists each fix and the churn it prevents. A larger reshape spins into its own `/flue-planning` → `/flue-executing` cycle instead. File project-specific root causes as GitHub issues (`gh issue create`). If nothing was discovered (clean run), skip.

### 7. Close out

- Set the plan's Status to `POSTMORTEM_COMPLETE`.
- `mkdir -p ~/c0de/plans/effect-flue/done && mv ~/c0de/plans/effect-flue/<plan>.md ~/c0de/plans/effect-flue/done/`.
- Offer `/flue-cleaning-up` once the PRs merge (feature + this skills PR).

## Why this skill matters

This is the mechanism by which the whole suite improves. v1 of every `flue-*` skill is deliberately thin; postmortem findings are how they grow. If a postmortem produces zero skill edits, look harder — or say explicitly why the run was clean.
