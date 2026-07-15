---
name: efflux-creating-issues
description: Turn a rough problem statement into one well-formed gh issue create — right-sized, problem-not-prescription.
argument-hint: "<rough problem statement>"
---

# Creating Issues

Turn ONE rough problem statement into ONE well-formed `gh issue create`.

- **Right-sized**: a one-line bug gets a three-line issue; a substantive problem gets the full scaffold. Don't pad small issues or starve big ones.
- **Problem, not prescription**: describe what is wrong and what outcome is wanted. Do not dictate the implementation unless the user explicitly wants a specific approach recorded.
- **NOT in scope**: PR creation, triage automation, editing existing issues.

## Steps

### 1. Intake

Gather from the rough statement (grep the repo when the user is vague):

- **Type prefix** for the title: `feat` / `fix` / `chore` / `refactor` / `docs` (conventional-commit style, e.g. `fix: streaming endpoint drops done frame`).
- **Affected paths** by exact `file:line` — e.g. `packages/shared/src/AgentApi.ts:57`. Grep to pin these down; never hand-wave "somewhere in the API".
- **Evidence** available now: live-worker `curl` output, `bun run tail` logs, exact repro steps. Quote it verbatim in the body.
- **A user-facing affordance described by SYMPTOM ("when it's loading it says Loading…", "when X the button goes grey") — pin the observable MOMENT with the user BEFORE letting a `grep` pick the target.** The literal UI text's location is not necessarily the moment the user means: grepping the string finds *a* spot, but a rarely-hit, sub-second, or secondary one is easily the WRONG one. Ask which moment ("which loading — the chat waiting for a reply? a panel load? which screen?") and scope the issue to THAT moment, not to wherever the string happens to live. (branded-flux-spinner: "when it's loading it says Loading… i want a spinner" was grepped to the ONE literal `Loading…` in an obscure "view last run" panel; the user actually meant the chat's wait-for-first-token, so the whole feature was rebuilt in a second location after the PR.)

### 2. Dedup

Before drafting, search open AND closed issues:

```bash
gh issue list --state all --search "<keywords>"
```

If a match exists, report it to the user instead of drafting a duplicate.

### 3. Labels

Pull the live label set — never invent labels:

```bash
gh label list
```

Only use labels that appear in that output.

### 4. Body scaffold

```markdown
## Problem

<what is wrong, with evidence: file:line refs, curl output, log lines, repro steps>

## Requested outcome

<observable behavior once fixed — not an implementation plan>

## Out of scope

<optional — only when boundaries are genuinely unclear>
```

For a trivial bug, collapse to a short `## Problem` + one-line outcome.

### 5. Draft and confirm

Draft the full command, show it to the user, and **WAIT for confirmation before running it**:

```bash
gh issue create \
  --title "fix: <short summary>" \
  --label "<label-from-gh-label-list>" \
  --body "$(cat <<'EOF'
## Problem
...
## Requested outcome
...
EOF
)"
```

Never run `gh issue create` without explicit user approval of the exact title, labels, and body.
