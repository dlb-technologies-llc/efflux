---
name: flue-verifying
description: The deploy-and-test checklist — a change counts as verified only after exercising it against the live worker.
argument-hint: "[worker-url]"
---

# Verifying Changes

A change is verified only when it has been exercised against the LIVE worker. `bun run typecheck` or a successful build alone NEVER counts as verification.

There are no lint or test scripts in this repo — the live checklist below is the whole verification story.

## Checklist

Run every step; report a per-check pass/fail table at the end.

### 0. Validate the API key first

```bash
curl -s https://openrouter.ai/api/v1/auth/key -H "Authorization: Bearer $(grep OPENROUTER_API_KEY .dev.vars | cut -d= -f2-)"
```

The local file is `.dev.vars` (not `.env`). Expect key metadata, not a 401 — a dead/rotated key once burned a full deploy cycle before surfacing as `InvalidKey`. If the key changed, re-run `wrangler secret put OPENROUTER_API_KEY` before deploying. **Caveat:** local `.dev.vars` may hold a placeholder while the deployed Worker uses a real secret from `wrangler secret put` — then a 401 here is expected and NOT a failure; the deployed key is proven by the first smoke turn (step 2). Only chase this check when the smoke turn itself fails with an auth-shaped error.

### 1. Typecheck and deploy

```bash
bun run typecheck
bun run deploy
```

If a hook/policy blocks the `deploy` package script, run its exact steps directly instead: `bun run build && bun scripts/upload-skills.ts && bunx wrangler deploy`.

Always use the `deploy` **package script** — its `predeploy` hook runs `bun run build` (frontend + API typecheck) and `bun scripts/upload-skills.ts`. Bare `wrangler deploy` skips the hook and can ship a stale `apps/web/dist`. `bun run deploy` needs a local Docker daemon (it builds the Sandbox container image).

Capture the worker URL from the deploy output (currently https://effect-flue.david-0e2.workers.dev). If it isn't printed, use the `[worker-url]` argument or `BASE_URL` env; if neither exists, ask the user.

Concurrent sessions share this ONE worker — last deploy wins. If another session may have deployed since yours, redeploy immediately before smoking; a mid-smoke deploy by another session invalidates results (rerun the affected checks). Container-image changes roll out gradually — when the diff touches the container, probe it first (e.g. a `pwd`-style Bash-tool turn) before judging dependent checks.

### 2. Smoke a session

```bash
bun scripts/agent.ts support smoke-<YYYYMMDD-HHMM> --message "Reply with the word pong." --url <URL>
```

Expect a coherent assistant reply. (Flags: `--message` required; `--url` or `BASE_URL`; optional `--model`, `--skill`, `--role`.)

### 3. History

```bash
curl <URL>/agents/support/smoke-<YYYYMMDD-HHMM>
```

Expect a `history` array containing the user turn just sent and the assistant reply.

### 4. Streaming

```bash
curl -N -X POST <URL>/agents/support/smoke-<YYYYMMDD-HHMM>/stream \
  -H 'content-type: application/json' \
  -d '{"message":"Count to three."}'
```

Expect multiple SSE `data:` frames (`text-delta` parts) ending in a `done` frame.

OPTIONAL (MANDATORY for changes touching the stream path): mid-stream disconnect probe — kill an SSE client mid-stream, then GET history and expect the partial assistant text persisted. Timing matters: kill only AFTER non-empty `text-delta` frames are flowing (reasoning models emit empty deltas for many seconds first) — a fixed short timer produces a false "nothing persisted" because there was nothing to persist yet. Ask for a long deterministic output (e.g. "a numbered list of 30 facts") and kill ~20s in.

**KNOWN-FAILING (pre-existing, #54):** on client disconnect NOTHING persists — not even the user message; `wrangler tail` shows the stream request `Canceled` with no subsequent `Agent.append` and no "Failed to persist chat turn" log. Reproduced on unmodified `main` (`1b937bbb`, 2026-07-08). If the probe fails with exactly this signature, record it as pre-existing #54 in the report — do NOT redeploy `main` to re-baseline (that archaeology is already done). Any OTHER failure shape (partial persistence, error frames, stream not `Canceled`) is your change's problem. Remove this note when #54 closes.

### 5. Subagent task

```bash
curl -X POST <URL>/tasks \
  -H 'content-type: application/json' \
  -d '{"prompt":"Say hello.", "skill":"support"}'
```

**The field is `prompt`, not `message`** — session endpoints (`/agents/:name/:id`, `/stream`) take `{message, model?, skill?, role?}`; `/tasks` takes `{prompt, model?, skill?, role?}`. Expect 200 with `text`.

Also probe an unknown skill and expect a structured 4xx body:

```bash
curl -X POST <URL>/tasks -H 'content-type: application/json' \
  -d '{"prompt":"hi", "skill":"no-such-skill"}'
```

All raw curls need `-H 'content-type: application/json'` — `curl -d` defaults to form-encoded.

### 6. Tool loop / sandbox

Force the Bash tool through a session prompt:

```bash
bun scripts/agent.ts support smoke-<YYYYMMDD-HHMM> \
  --message "Run \`uname -a\` in your sandbox and tell me the output." --url <URL>
```

Expect real command output in the reply. Pass `--model` with a capable tool-calling model (e.g. `openai/gpt-4o-mini`) — the default `tencent/hy3:free` flakes at tool choice, and a no-tool reply then looks like a code failure when it isn't. Model tool choice is still nondeterministic — retry once with a more explicit instruction (AFTER pinning the model) before declaring failure.

### 7. Cleanup

```bash
curl -X DELETE <URL>/agents/support/smoke-<YYYYMMDD-HHMM>
```

Resets the smoke session.

### 8. Report

Emit a per-check pass/fail table. Any fail means the change is **NOT verified** — investigate with `bun run tail` before touching more code.

## Cost note

Each smoke turn spends real model tokens. Keep messages short and don't loop the checklist unnecessarily — one clean pass is enough.
