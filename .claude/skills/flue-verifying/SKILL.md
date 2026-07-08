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

### 1. Typecheck and deploy

```bash
bun run typecheck
bun run deploy
```

Always use the `deploy` **package script** — its `predeploy` hook runs `bun run build` (frontend + API typecheck) and `bun scripts/upload-skills.ts`. Bare `wrangler deploy` skips the hook and can ship a stale `apps/web/dist`. `bun run deploy` needs a local Docker daemon (it builds the Sandbox container image).

Capture the worker URL from the deploy output (currently https://effect-flue.david-0e2.workers.dev). If it isn't printed, use the `[worker-url]` argument or `BASE_URL` env; if neither exists, ask the user.

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

OPTIONAL (only for changes touching the stream path): mid-stream disconnect probe — kill an SSE client mid-stream, then GET history and expect the partial assistant text persisted.

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

Expect real command output in the reply. Model tool choice is nondeterministic — retry once with a more explicit instruction before declaring failure.

### 7. Cleanup

```bash
curl -X DELETE <URL>/agents/support/smoke-<YYYYMMDD-HHMM>
```

Resets the smoke session.

### 8. Report

Emit a per-check pass/fail table. Any fail means the change is **NOT verified** — investigate with `bun run tail` before touching more code.

## Cost note

Each smoke turn spends real model tokens. Keep messages short and don't loop the checklist unnecessarily — one clean pass is enough.
