---
name: efflux-releasing
description: Promote staging→main via a merge PR (carrying the Closes #N lines), then tag and publish a semver GitHub Release — the only path work takes into main.
argument-hint: "[version]"
---

# efflux-releasing

Purpose: releases are the ONLY way work reaches `main`. Feature PRs land on `staging` (with `Refs #N`); this skill opens the `staging`→`main` promotion PR (whose body carries the `Closes #N` lines so issues auto-close on release), and every merge to `main` gets a release — a semver git tag on the merge commit plus a GitHub Release with generated notes.

## Step 0: Promote staging → main

1. ```bash
   git fetch origin main staging
   git log --oneline origin/main..origin/staging
   ```
   Empty → nothing to release; stop. Otherwise list the staging PRs being promoted (`gh pr list --base staging --state merged` since the last release helps).
2. Collect every issue the promoted PRs reference (`Refs #N` in their bodies) — each becomes a `Closes #N` line in the promotion PR body. This is the ONLY place `Closes #N` is used.
3. **Live-validate the promoted batch — the release gate.** A green CI run and a clean local `typecheck`/`test`/`lint` are necessary but NOT sufficient: they prove the code compiles and the unit tests pass, never that the assembled batch's features actually work. Before opening the promotion PR, run the current `staging` head against a RUNNING worker per `/efflux-verifying` — local `bun run dev` / `bun run dev:local` is the default (free, full-fidelity, zero deploy) — and exercise the **headline feature of every `feat` PR in the batch end-to-end**: drive the real endpoint or tool and capture the ACTUAL output (an exit code or a `200` is not proof — a scheduled-job run-now must show its captured stdout, a secret rotate must round-trip, an FE change must render). Per-PR verification at merge time is assumed but does NOT substitute — features interact, and a batch can regress in ways no single PR's check caught. Record the result as a **per-feature pass/fail table in the promotion PR body under a `## Live validation` heading**, so the release visibly certifies that everything was tested, not merely merged. If a feature can't be validated (needs a real external side effect, a deploy-only path), say so explicitly rather than implying it passed.
4. Open and merge the promotion PR (merge commit — never rebase/squash, never `--no-verify`):
   ```bash
   gh pr create --base main --head staging --title "release: <X.Y.Z summary>" --body "..."
   ```
   Confirm with the user before merging.
5. After the merge, sync `staging` back up to `main` so the next feature branch includes the release merge commit (fast-forward push):
   ```bash
   git fetch origin main
   git push origin origin/main:staging
   ```
   The fast-forward **refuses whenever `staging` has diverged from the new `main`** — either someone landed on staging mid-release, OR a PRIOR release's sync-back was skipped (so staging never got that earlier release merge commit and the two branches share only an older base). Same fix in both cases: merge `main` → `staging` via a PR instead of force-anything. Verify the sync-back actually ran before starting the NEXT release — a skipped one silently compounds the divergence.

Then tag + release the new `main` merge commit (steps below).

## Versioning rules

- Current version = highest existing tag: `git tag --sort=-v:refname | head -1`. If NO tags exist, start at `0.1.0`.
- Pre-1.0 policy: if the promoted batch contains ANY `feat` PR, bump MINOR; otherwise (`fix`/`chore`/`docs`/`refactor` only) bump PATCH.
- NEVER bump to 1.0.0 or change MAJOR unless the user explicitly says so.
- Tag format: bare `X.Y.Z` — no `v` prefix.

## Steps

### 1. Fetch main — never checkout

```bash
git fetch origin main
```

NEVER `git checkout` in the main working copy. Tag the fetched `origin/main` ref directly.

### 2. Confirm the target commit

- `git log --oneline origin/main -1` — confirm this is the merge commit to tag.
- `git tag --points-at origin/main` — if a tag already exists there, stop and report it.

A release marks a **merged, live-validated** state — Step 0's validation gate has certified the batch against a running worker, not merely that each PR was individually PR-verified. Releases do NOT deploy — deploying stays a separate, manual `bun run deploy`; the Step 0 validation runs against a LOCAL worker (`bun run dev`), which certifies behavior without a deploy. Never cut a release on `typecheck`/`test`/CI-green alone — those never exercise a running worker, so they cannot prove the features work; if Step 0's live validation was skipped, say so and run it before tagging, and don't claim the tag proves anything the validation didn't.

### 3. Compute the next version

- Read the highest tag (rules above) and the merge's conventional-commit type.
- Show the user `current → next` and confirm before tagging.
- If a `[version]` argument was given, it overrides the computed bump — still confirm, and still never a MAJOR bump without the user asking.

### 4. Tag and push

```bash
git tag -a <X.Y.Z> origin/main -m "release: <one-line summary>"
git push origin <X.Y.Z>
```

Push tags one at a time.

### 5. Create the GitHub Release

```bash
gh release create <X.Y.Z> --generate-notes --title "<X.Y.Z>"
```

Notes are auto-generated from PRs since the previous tag.

## Catch-up (multiple untagged merges)

Every commit to `main` gets its OWN release — including backfill. If several merges landed untagged, tag EACH untagged first-parent commit individually, oldest → newest (`git rev-list --reverse --first-parent <last-tag>..origin/main`), bumping per that commit's type (feat → MINOR, else PATCH), pushing tags one at a time, then `gh release create` for each oldest → newest so generated notes diff against the previous tag. Never collapse a batch into one catch-up release. (Established when the pre-release history was backfilled as 0.1.0–0.13.0, one release per commit.)

---

Lean v1 — sharpened over time by `/efflux-postmortem`.
