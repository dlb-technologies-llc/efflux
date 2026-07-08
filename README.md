# effect-flue

> A deployable Cloudflare agent runtime built from Effect v4 on native Workers bindings. No framework required.

[Flue](https://flueframework.com) bills itself as "The Agent Harness Framework" — Claude Code, but headless and programmable. Every primitive it ships (per-session DOs, R2-backed skills, a container sandbox, a model client, an HTTP trigger surface) is something you already have on Cloudflare + Effect. This repo proves it: a complete Support Agent with streaming chat UI, every line written in `effect`, `@effect/ai-openrouter`, or `@effect/atom-react`, deployed with plain `wrangler`.

## What's in here

```
wrangler.jsonc            # Stack: Worker + DOs (Agent, Sandbox container) + R2 + cron + assets
apps/
  api/                    # Cloudflare Worker (HttpApi + DurableObjects + Container)
    container/            # Sandbox container image (Dockerfile + server.ts)
    src/
      index.ts            # Worker entry — composes HttpApi + serves the FE
      Agent.ts            # Agent DurableObject — sessions, prompt, streamPrompt
      handlers.ts         # HttpApi handlers (prompt, history, reset, stream, tasks)
      Sandbox.ts          # Sandbox container DO (@cloudflare/containers)
      Skills.ts           # R2 skills/roles loading
  web/                    # Vite + React FE (chat UI)
    src/
      App.tsx             # Layout + transcript
      atoms.ts            # @effect/atom-react Query + Mutation atoms
      runtime.ts          # Effect runtime + HttpApiClient
      components/         # Chat UI components
packages/
  shared/                 # HttpApi definition, schemas, error types
    src/                  # AgentApi, Message, PromptResponse, StreamPart, ...
scripts/
  upload-skills.ts        # Syncs apps/api/{skills,roles}/*.md into R2 (predeploy)
  agent.ts                # Live smoke CLI
tsconfig.base.json
```

## The architecture

The Worker owns a single HttpApi defined in `@effect-flue/shared`. The same `HttpApi` shape is used three ways:

1. Server: `HttpApiBuilder.layer(AgentApi)` mounts handlers in `apps/api/src/handlers.ts`.
2. Client: `HttpApiClient.make(AgentApi, …)` in `apps/web/src/runtime.ts` gives the FE a fully typed call surface.
3. Stream contract: `StreamPart` is a tagged union; every SSE frame is `Schema.encodeSync(StreamPart)` on the server and `Schema.decodeUnknownEffect(StreamPart)` on the client.

```
┌───────────────────────┐                  ┌────────────────────────────────┐
│   Browser (React)     │   HTTP / SSE     │  Cloudflare Worker (index.ts)  │
│                       │ ───────────────► │                                │
│  apps/web             │                  │   HttpApiBuilder.layer(        │
│   • atom-react Query  │                  │     AgentApi                   │
│   • atom-react Mutation                  │   )                            │
│   • HttpApiClient     │                  │                                │
│   • StreamPart decode │                  │   handlers.ts: prompt /        │
│                       │                  │     history / reset / stream   │
└───────────────────────┘                  └────────────┬───────────────────┘
                                                        │
                                                        │ DurableObjectNamespace.getByName
                                                        ▼
                                            ┌────────────────────────────────┐
                                            │  Agents (DurableObject)        │
                                            │   • history in DO storage      │
                                            │   • prompt()  — generateText   │
                                            │   • streamPrompt() — streamText│
                                            └──┬──────────┬──────────┬───────┘
                                               │          │          │
                                       OpenRouter    R2 (skills)  Container
                                       LanguageModel              (Sandbox)
```

The FE talks to `/agents/*` over the typed client. Streaming uses `POST /agents/<name>/<id>/stream`, which returns `text/event-stream`. Inside the Worker, `LanguageModel.streamText` produces a Stream; the handler maps each frame through `StreamPart` and writes `data: <json>\n\n`. The browser decodes back into the same union and renders deltas as they arrive.

## How it's used

Every endpoint is a method on the `AgentApi` HttpApi:

```sh
# Start (or continue) a session — default model
curl https://<your-worker>/agents/support/user-abc \
  -d '{"message": "How do I reset my password?"}'

# Same id continues the conversation; caller picks the model
curl https://<your-worker>/agents/support/user-abc \
  -d '{
    "message": "Summarize what we discussed",
    "model": "openai/gpt-5.2"
  }'

# Inspect history
curl https://<your-worker>/agents/support/user-abc

# Reset
curl -X DELETE https://<your-worker>/agents/support/user-abc

# Stream the next reply as SSE
curl -N https://<your-worker>/agents/support/user-abc/stream \
  -d '{"message": "Walk me through this slowly"}'
```

Each `<name>/<id>` pair routes to one `Agent` DurableObject instance with its own history, container sandbox, and bindings.

### Subagent tasks — `POST /tasks`

A separate top-level endpoint runs a one-shot "subagent" prompt and returns just the assistant text. It deliberately does **not** touch any `Agent` DurableObject — no history is persisted, no parent session is mutated. The URL is intentionally top-level (`/tasks`, not `/agents/<name>/<id>/task`) so the contract reflects that there is no session affinity.

```sh
# Raw passthrough — no system prompt
curl https://<your-worker>/tasks \
  -d '{"prompt": "echo: hello"}'

# Overlay a skill (loaded from apps/api/skills/<name>.md in R2)
curl https://<your-worker>/tasks \
  -d '{"prompt": "Customer wants to know about refunds", "skill": "support"}'

# Overlay both a skill and a role (loaded from apps/api/roles/<name>.md)
curl https://<your-worker>/tasks \
  -d '{"prompt": "My login broke", "skill": "support", "role": "triager"}'

# Override the model
curl https://<your-worker>/tasks \
  -d '{
    "prompt": "Summarize the password reset flow",
    "skill": "support",
    "model": "openai/gpt-5.2"
  }'
```

`skill` and `role` are both optional `SafeName`-bounded strings (alphanumeric / `-` / `_`, 1–64 chars) and resolve to **independent R2 keyspaces**: `skills/<name>.md` and `roles/<name>.md`. Passing the same string for both — e.g. `{"skill":"support","role":"support"}` — is legal and overlays two system messages from two distinct files. The R2 bucket is the same source the per-session `POST /agents/:name/:id` prompt path uses. Unknown values produce a structured 404 JSON body (`SkillNotFoundError` / `RoleNotFoundError`). Missing values produce a raw passthrough (no system message) — **note** that this differs from the `/agents/:name/:id` paths, which default `skill` to `"support"` when omitted. Adding a new skill or role is a file drop: write `apps/api/<skills|roles>/<name>.md` and redeploy — `scripts/upload-skills.ts` (run by the `predeploy` hook) uploads all `.md` files to R2 on every deploy (idempotent puts, no diffing).

## Working on this repo

Changes flow through a plan → execute → verify → postmortem loop, driven by six skills under `.claude/skills/`:

- `/flue-planning` — wave-structured implementation plan for a task.
- `/flue-executing` — runs the plan wave-by-wave and opens the PR against `main`.
- `/flue-creating-issues` — turns a rough problem statement into one well-formed GitHub issue.
- `/flue-verifying` — deploy + live-worker smoke checklist; typecheck alone never counts as verified.
- `/flue-postmortem` — pre-merge orchestration retrospective that feeds improvements back into the skills.
- `/flue-cleaning-up` — post-merge branch deletion and plan archival.

`CLAUDE.md` at the repo root holds the current commands, conventions, and a skill index; `ISSUES.md` records known landmines — read it before touching Worker boot, secrets, DO RPC boundaries, containers, or the tool loop.

Releases: every merge to `main` is tagged and published as a GitHub Release (semver, starting from 0.1.0).

## The chat UI

`apps/web` is a Vite + React app. It does not duplicate any type from the Worker — every request and response goes through:

```ts
// apps/web/src/runtime.ts
const client = yield* HttpApiClient.make(AgentApi, { baseUrl: window.location.origin });
```

Mutations (send, reset) are `@effect/atom-react` mutation atoms; the history view is a query atom. The streaming endpoint is consumed as a `Stream<StreamPart>`, validated frame-by-frame via `Schema.decodeUnknownEffect(StreamPart)`. If the server adds a new part variant tomorrow, the client breaks at the schema, not at a `JSON.parse` followed by a `switch`.

In dev, Vite's proxy forwards `/agents/*` to the local Worker at `http://localhost:8787`. In production, the FE is served from the same Worker, so `window.location.origin` resolves to the Worker hostname and no CORS is involved.

## Streaming

The DurableObject `streamPrompt` method returns a `Stream` driven by `LanguageModel.streamText`. The Worker handler wraps that stream with `Stream.map(part => textEncoder.encode("data: " + JSON.stringify(encodeStreamPart(part)) + "\n\n"))` and hands it to `HttpServerResponse.stream`.

The DO accumulates `text-delta` parts into a local buffer as the stream runs, and uses `Stream.ensuring` to persist whatever it has when the stream terminates — successfully or otherwise. If the client disconnects mid-stream, the assistant's partial text is saved with `finishReason: "interrupted"`, so the next `GET /agents/<name>/<id>` shows the partial reply, not nothing.

On the browser side the same `StreamPart` schema decodes each SSE frame. Unknown tags are filtered out, so a server that emits a new variant won't crash the UI — old clients just stop rendering the new frames.

## Dev

Prerequisite: a local Docker daemon (the `Sandbox` container image builds locally for `dev` and `deploy`). Local secrets go in `.dev.vars` (copy `.dev.vars.example`) — **required before `bun run typecheck` too**: the generated `worker-configuration.d.ts` derives `Env.OPENROUTER_API_KEY` from `.dev.vars`, so a fresh clone without it fails typecheck.

```sh
bun install

# Two terminals (no concurrent runner is wired):
bun run dev                                   # terminal 1 — wrangler dev (Worker at :8787, needs Docker)
bun run --filter @effect-flue/web dev         # terminal 2 — Vite (FE at :5173, proxies /agents)

bun run typecheck                             # cf-typegen, then tsc --noEmit across the three tsconfigs
bun run build                                 # builds the FE then typechecks the Worker
```

`bun run typecheck` chains `bun run cf-typegen` (`wrangler types`) first, regenerating the gitignored `worker-configuration.d.ts` from `wrangler.jsonc`. `bun run build` runs the Vite build (`apps/web/dist`), then `tsc --noEmit` against `apps/api/src`. `wrangler.jsonc` declares `assets.directory: "./apps/web/dist"` with `run_worker_first` on `/agents/*` and `/tasks*`, so the same Worker serves both the HttpApi and the built FE on deploy.

## Deploy

```sh
wrangler secret put OPENROUTER_API_KEY   # once per Worker
bun run deploy                           # requires Docker (container image build)
```

The `predeploy` script runs `bun run build` and `bun scripts/upload-skills.ts` first, so a stale or missing `apps/web/dist` can't ship and R2 skills/roles stay in sync. `wrangler deploy` reads `wrangler.jsonc` at the repo root, which declares the Worker, the `Agent` and `Sandbox` DurableObjects (the latter a container built from `apps/api/container/Dockerfile`), the `SKILLS` R2 bucket, the cron trigger, and the FE assets.

Useful root scripts:

| Script              | What it does                                                     |
| ------------------- | ---------------------------------------------------------------- |
| `bun run dev`       | `wrangler dev` — local Worker + emulated bindings (needs Docker)  |
| `bun run deploy`    | `wrangler deploy` (runs `predeploy` first; needs Docker)          |
| `bun run tail`      | `wrangler tail` — stream Worker logs                              |
| `bun run typecheck` | `cf-typegen` + `tsc --noEmit` across the three tsconfigs          |
| `bun run cf-typegen`| `wrangler types` — regenerate `worker-configuration.d.ts`         |

## The claim

The original Flue Support Agent example is ~30 lines. This repo is larger — but every line is something you can point at and explain:

| Flue                                 | Underlying CF primitive   | What we use                              |
| ------------------------------------ | ------------------------- | ---------------------------------------- |
| Persistent session by URL `<id>`     | Durable Object            | native DO binding (`wrangler.jsonc`)     |
| Sandbox                              | CF Containers             | `@cloudflare/containers` `Container` DO  |
| Skills / AGENTS.md                   | R2                        | native R2 binding + `scripts/upload-skills.ts` |
| Model + tools                        | —                         | `@effect/ai-openrouter` + `effect/unstable/ai` |
| Webhook                              | Worker                    | plain Worker entry (`apps/api/src/index.ts`) |
| Typed output                         | Valibot                   | `effect/Schema`                          |
| Secrets                              | —                         | `wrangler secret` + `.dev.vars`          |
| Streaming                            | SSE                       | `Stream` + `HttpServerResponse.stream`   |
| Chat UI                              | —                         | React + `@effect/atom-react` + `HttpApiClient` |
| Deploy                               | `flue build`              | `wrangler deploy`                        |

**What you give up:** convenience and a zero-config DX. Flue does auto-wiring you have to do once here.

**What you gain:**

- No framework lock-in. Every line is `effect`, `@effect/ai-openrouter`, or `@effect/atom-react`, on stock Cloudflare bindings.
- One schema, two sides. `AgentApi` and `StreamPart` are defined once in `packages/shared` and consumed by the Worker and the FE — the typechecker enforces that they agree.
- Full Effect composition — Layers, Fibers, structured concurrency, OpenTelemetry, retry policies, schema-validated streaming.
- Infra-as-code in the same file tree. `wrangler.jsonc` declares the DOs, R2 bucket, container image, cron, assets, and Worker.
- Mid-stream disconnect leaves consistent state on disk, not a half-written row.
- Testable services. Each piece is a Layer you can swap.

The foundation requires no framework.
