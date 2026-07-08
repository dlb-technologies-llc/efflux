---
name: flue-releasing
description: Tag and publish a semver GitHub Release for effect-flue after a PR to main merges, or when the user asks to cut/tag a release.
argument-hint: "[version]"
---

# flue-releasing

Purpose: every merge to `main` gets a release — a semver git tag on the merge commit plus a GitHub Release with generated notes.

## Versioning rules

- Current version = highest existing tag: `git tag --sort=-v:refname | head -1`. If NO tags exist, start at `0.1.0`.
- Pre-1.0 policy: `feat` merges bump MINOR; `fix`/`chore`/`docs`/`refactor` merges bump PATCH.
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

A release marks a **merged, PR-verified** state. Releases do NOT deploy — deploying stays a separate, manual `bun run deploy`. If the merged PR skipped live verification, say so and offer to deploy + run `/flue-verifying` first, but don't claim the tag itself proves deployability.

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

If several merges landed on `main` untagged, tag only the current HEAD of main with ONE release covering all of them. The bump is the highest type in the batch: any `feat` → MINOR, else PATCH. Don't retro-tag intermediate commits.

---

Lean v1 — sharpened over time by `/flue-postmortem`.
