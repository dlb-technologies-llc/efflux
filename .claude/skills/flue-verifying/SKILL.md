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

If a hook/policy blocks the `deploy` package script, run its exact steps directly instead: `bun run build && bun scripts/upload-skills.ts && bunx wrangler deploy`. Do NOT stop to ask the user to deploy — that raw-wrangler fallback IS the sanctioned agent path when the package script is hook-blocked; run it directly.

Always use the `deploy` **package script** — its `predeploy` hook runs `bun run build` (frontend + API typecheck) and `bun scripts/upload-skills.ts`. Bare `wrangler deploy` skips the hook and can ship a stale `apps/web/dist`. `bun run deploy` needs a local Docker daemon (it builds the Sandbox container image).

Capture the worker URL from the deploy output (currently https://effect-flue.david-0e2.workers.dev). If it isn't printed, use the `[worker-url]` argument or `BASE_URL` env; if neither exists, ask the user.

Concurrent sessions share this ONE worker — last deploy wins. If another session may have deployed since yours, redeploy immediately before smoking; a mid-smoke deploy by another session invalidates results (rerun the affected checks). A clobber by another session has a recognizable SIGNATURE — before blaming your code: routes you ADDED return 404 (or 405, when a `PUT`/`POST` to an added route falls through to the static-asset handler, which only serves GET/HEAD), config/model changes you made silently don't apply, and turns may 500 mid-swap. Confirm YOUR build is live by polling a route unique to your branch (a new endpoint) for a STABLE 200 — several hits over ~20s, not one — before running the affected checks. A fresh `wrangler deploy` also needs a few seconds to propagate, so a curl fired within ~1s of deploy can transiently 404/500 on your own routes; poll for the stable 200 first. `wrangler tail` is UNHELPFUL for diagnosing this — the clobbering deploy makes your request show `outcome: ok` with empty logs from the other build, not an error. Container-image changes roll out gradually — when the diff touches the container, probe it first (e.g. a `pwd`-style Bash-tool turn) before judging dependent checks.

**New-route changes:** if the diff adds a path to `run_worker_first` (wrangler.jsonc) or `isApiPath` (index.ts), the asset-routing config can lag ONE deploy — a GET to the new path returns the SPA `index.html` (200, `content-type: text/html`) and a non-GET 405s from the asset handler, even when the Worker code is correct. Redeploy once and re-probe the **exact new path**; the route is verified only when it returns the Worker's JSON, not SPA HTML. (Seen #41: `GET /skills` served the SPA after the first deploy; a second deploy fixed it.)

**New secret / client build-time token — a deploy step, not just a code change.** If the diff adds a REQUIRED Worker secret (read via `env.X` / a `requireX(env)` guard), the deployed Worker has it ONLY after `wrangler secret put <SECRET>` — `.dev.vars` is local-only, so the deployed Worker **fail-closes at boot** (every request 500s) until you set it. If the diff adds a token the FE bakes in at build (a `VITE_*` env, e.g. an auth bearer), the deployed FE **401s on every call** until it is REBUILT with that value (`VITE_X=<value> bun run build`) and redeployed — and a curl smoke that puts the token in the header will PASS while the real FE is broken. Elicit this at kickoff ("does the change add a secret or a client-baked token?") and do the secret-set + client-rebuild BEFORE smoking. (best-practices-refactor #73: added `API_TOKEN` + `VITE_API_TOKEN`; the deployed FE 401'd on every panel until the **user** reported it, because verification was curl + CLI only.)

### 1b. Frontend render — MANDATORY when the diff touches `apps/web/**`

Curling endpoints does NOT verify the UI. A frontend change is verified only when the actual page RENDERS — that `index.html` serves and the JS bundle 200s proves nothing about whether React mounted. Endpoint-only "verification" of an FE PR is a known miss (showcase-ui #67 was declared verified via curl; the UI was never loaded in a browser until the user asked "have you tested this?"). Load the deployed SPA headless and assert it mounts:

```bash
google-chrome --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --user-data-dir="$(mktemp -d)" --window-size=1440,900 --virtual-time-budget=9000 \
  --screenshot=/tmp/render.png --dump-dom "<URL>/?cb=$RANDOM" > /tmp/dom.html
```

Then `grep` the dumped DOM for markers unique to your change (panel headings, new component text, expected data values) and `Read` `/tmp/render.png` to eyeball the layout. A near-empty `#root`, a DOM missing your markers, or the old bundle name = the app crashed on mount or a stale build is live — a FAIL even though every endpoint passed.

**"Mounts" is not "works" for an auth-gated or data-driven UI.** React mounts fine while every data fetch 401s or errors, so a shell full of "Failed to load …" still renders a non-empty `#root`. Grep the dumped DOM for error markers too — `Failed to load`, `401`, `Decode error`, `Unauthorized` — and assert they are ABSENT; their presence is a FAIL even though the page "rendered". A curl/CLI smoke NEVER substitutes for this load. (best-practices-refactor #73: the curl auth checks all passed while the deployed FE showed "Failed to load sessions/history/journal" on every panel — the FE sent an empty bearer because it wasn't rebuilt with `VITE_API_TOKEN`.)

Run this against the DEPLOYED worker, not local: `wrangler dev` (local) uses the placeholder `.dev.vars` key so model turns fail, and `wrangler dev --remote` no longer supports Durable Objects (`/agents`, `/journal`, chat, approvals all 500) — neither gives a full-fidelity FE demo. Confirm YOUR build is live first via the clobber-signature check in step 1 (poll a branch-unique route for a stable 200), then redeploy-and-recheck if a sibling session may have shipped over you.

**Authed-data caveat (since #73's auth) — the deployed-SPA headless load verifies MOUNT ONLY.** The public bundle carries no token (`VITE_API_TOKEN` is empty in the deployed build), so a headless load of the deployed SPA 401s on every authed call (`/agents`, `/journal`, sessions) — it proves React mounted, NEVER that a new authed-data component (a journal timeline, a session list, an approvals card) actually *renders its data*. To verify that, run a **local Vite dev build pointed at the deployed worker**:
- Temporarily set `apps/web/vite.config.ts`'s `server.proxy` targets to the deployed URL — `"/agents": { target: "<worker-url>", changeOrigin: true, secure: true }` (repeat for `/skills`, `/tasks`, `/meta`). This edit is TEMPORARY and NOT part of the PR — revert it after (`git checkout apps/web/vite.config.ts`).
- Start it with the real token: `cd apps/web && VITE_API_TOKEN=<API_TOKEN> bunx vite --port 5173 --strictPort`.
- Seed the session's data via the API (the CLI / curl), then headless-load `http://localhost:5173/?cb=$RANDOM`, `--dump-dom`, grep for the change's data markers (todo rows, a "context compacted" divider, …), and `Read` the screenshot. Zero "Failed to load" in the DOM = the token reached the worker.

Footgun: kill the dev server by PORT (`lsof -ti tcp:5173 | xargs -r kill`), NEVER `pkill -f "vite --port 5173"` — that pattern also matches the shell command you're running it from and kills your own turn. And local `wrangler dev` binds `:8787`, which a sibling worktree's session may already hold ("Address already in use") — the local-Vite→deployed-worker path sidesteps that entirely. (Technique proven on compaction-todo #76, where the deployed SPA 401'd all journal data and only the local-Vite build rendered the new todo/compaction timeline.)

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

Pass `--model` with a capable tool-calling model (e.g. `openai/gpt-4o-mini`) — the default `tencent/hy3:free` flakes at tool choice, and a no-tool reply then looks like a code failure when it isn't. Model tool choice is still nondeterministic — retry once with a more explicit instruction (AFTER pinning the model) before declaring failure.

**`Bash` PARKS by default (since #40) — a plain smoke turn will NOT print command output.** The default rules are `{ Bash: "ask" }`, so the model's Bash call ends the turn with an `approval-requested` journal event and no output (the CLI renders something like `(Bash completed with no output)`). That is CORRECT behavior, not a failure — don't chase it as a code bug. To actually exercise the sandbox, either:
- (a) allow Bash for the smoke session first — `curl -X PUT <URL>/agents/support/smoke-<...>/config -H 'content-type: application/json' -d '{"rules":{"Bash":"allow"}}'` — then run the turn and expect real `uname -a` output; or
- (b) drive the approval, which doubles as approval-flow verification: read the `approval-requested` event's `seq` from `GET <URL>/agents/support/smoke-<...>/journal`, then `curl -X POST <URL>/agents/support/smoke-<...>/approve/<seq> -H 'content-type: application/json' -d '{"approved":true}'` and expect the continuation SSE to carry the command output plus a `tool-result` frame.

### 7. Cleanup

```bash
curl -X DELETE <URL>/agents/support/smoke-<YYYYMMDD-HHMM>
```

Resets the smoke session.

### 8. Report

Emit a per-check pass/fail table. Any fail means the change is **NOT verified** — investigate with `bun run tail` before touching more code.

## Cost note

Each smoke turn spends real model tokens. Keep messages short and don't loop the checklist unnecessarily — one clean pass is enough.
