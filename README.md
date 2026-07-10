# efflux

> A deployable Cloudflare agent runtime built from Effect v4 on native Workers bindings. No framework required.

Agent-harness frameworks bundle the primitives you need to run an agent — per-session state, R2-backed skills, a container sandbox, a model client, an HTTP trigger surface — behind a convenient DX. Every one of those primitives is something you already have on Cloudflare + Effect. Efflux proves it: a complete streaming agent runtime with a polished, dark-first web console, deployed with plain `wrangler` — no agent framework required. The runtime is pure `effect` + `@effect/ai-openrouter` on stock Cloudflare bindings; the console is React 19 + Tailwind v4 + shadcn/ui on the typed `@effect/atom-react` client.

## What's in here

```
wrangler.jsonc            # Stack: Worker + DOs (Agent, Sandbox, Registry) + R2 (SKILLS, SESSIONS) + cron + assets
apps/
  api/                    # Cloudflare Worker (HttpApi + DurableObjects + Container)
    container/            # Sandbox container image (Dockerfile + Effect HttpApp server.ts)
    src/
      index.ts            # Worker entry — composes HttpApi + serves the FE
      Agent.ts            # Agent DurableObject — append-only event journal + sandbox exec seam
      Registry.ts         # Registry DurableObject — session index for GET /agents
      handlers.ts         # HttpApi handlers + the Worker-side hop-capped tool loop
      Sandbox.ts          # Sandbox container DO (@cloudflare/containers)
      Skills.ts           # R2 skills/roles loading
  web/                    # Vite + React 19 console — Tailwind v4 + shadcn/ui, dark-first
    src/
      App.tsx             # AppShell composition (TopBar + rails + inspector tabs)
      index.css           # Tailwind v4 token layer — the /efflux-branding design system
      theme.ts            # dark-first theme atom + provider
      components/         # shared primitives (Markdown, ToolCallCard, Message, …) + panels
      atoms/              # @effect/atom-react state (history, journal, streaming)
      runtime.ts          # Effect runtime + typed HttpApiClient
  tui/                    # Ink terminal client (shares the typed client + streamAgentSse)
packages/
  shared/                 # HttpApi definition, schemas, errors, journal, shared SSE Stream
    src/                  # AgentApi, Message, PromptResponse, StreamPart, Journal, Sse, ...
scripts/
  lib.ts                  # Shared CLI plumbing (typed client, journal pagination, arg parse)
  upload-skills.ts        # Syncs apps/api/{skills,roles}/*.md into R2 (predeploy)
  agent.ts                # Live smoke CLI
  verify-journal.ts       # Journal prompt-reconstructibility checker
tsconfig.base.json
```

## The architecture

The Worker owns a single HttpApi defined in `@efflux/shared`. The same `HttpApi` shape is used three ways:

1. Server: `HttpApiBuilder.layer(AgentApi)` mounts handlers in `apps/api/src/handlers.ts`.
2. Client: `HttpApiClient.make(AgentApi, …)` in `apps/web/src/runtime.ts` gives the FE a fully typed call surface.
3. Stream contract: `StreamPart` is a tagged union; every SSE frame is `Schema.encodeSync(StreamPart)` on the server and `Schema.decodeUnknownEffect(StreamPart)` on the client.

```
┌───────────────────────┐                  ┌────────────────────────────────┐
│  Browser · TUI        │   HTTP / SSE     │  Cloudflare Worker (index.ts)  │
│                       │ ───────────────► │                                │
│  apps/web · apps/tui  │                  │  HttpApiBuilder.layer(AgentApi)│
│   • HttpApiClient     │                  │  handlers.ts: prompt/history/  │
│   • streamAgentSse    │                  │    reset/stream/journal/       │
│     (shared, Stream)  │                  │    sessions/task               │
│   • StreamPart decode │                  │  ── the hop-capped tool loop   │
│                       │                  │     (generateText/streamText)  │
│                       │                  │     runs HERE, not in the DO ──│
└───────────────────────┘                  └──────┬───────────────┬─────────┘
                                        getByName  │               │ idFromName("global")
                                                   ▼               ▼
                                   ┌────────────────────┐  ┌─────────────────────┐
                                   │ Agent (DO · SQLite) │  │ Registry (DO·SQLite)│
                                   │  • append-only      │  │  • session index    │
                                   │    event journal    │  │    for GET /agents  │
                                   │  • sandbox exec seam│  └─────────────────────┘
                                   └──┬───────────────┬──┘
                                      ▼               ▼
                             Container (Sandbox)   R2: SKILLS (skills/roles)
                             Bash + /workspace         SESSIONS (workspace tarballs)
```

OpenRouter's `LanguageModel` is provided at the Worker root (`aiLayer`) and consumed by the **Worker-side** loop — the `Agent` DO is now just the append-only journal plus the sandbox exec/hydrate seam; it does not drive the model. The FE talks to `/agents/*` over the typed client. Streaming uses `POST /agents/<name>/<id>/stream` (`text/event-stream`): the handler drives `LanguageModel.streamText`, journals events as they happen, and writes each `StreamPart` frame as `data: <json>\n\n`; the browser/TUI decode back into the same union via the shared `streamAgentSse` and render deltas as they arrive.

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

Changes flow through a plan → execute → verify → postmortem loop, driven by the `efflux-*` skills under `.claude/skills/`:

- `/efflux-planning` — wave-structured implementation plan for a task.
- `/efflux-executing` — runs the plan wave-by-wave in an isolated worktree and opens a PR against `staging`.
- `/efflux-creating-issues` — turns a rough problem statement into one well-formed GitHub issue.
- `/efflux-verifying` — deploy + live-worker smoke checklist; typecheck alone never counts as verified.
- `/efflux-postmortem` — orchestration retrospective that feeds improvements back into the skills.
- `/efflux-cleaning-up` — post-merge worktree removal, branch deletion, and plan archival.
- `/efflux-releasing` — promotes `staging`→`main` via a merge PR, then tags and publishes a GitHub Release.
- `/efflux-branding` — the design-system / brand-guidelines source of truth; invoke before any frontend work.

`CLAUDE.md` at the repo root holds the current commands, conventions, and a skill index; `ISSUES.md` records known landmines — read it before touching Worker boot, secrets, DO RPC boundaries, containers, or the tool loop.

Feature PRs target `staging` with `Refs #N`; `/efflux-releasing` promotes `staging`→`main` and tags the release. CI gates `typecheck` + `test` (vitest) + `lint` (biome) on every PR.

## The web console

`apps/web` is a Vite + React 19 console styled with **Tailwind v4 + shadcn/ui**, driven by the `/efflux-branding` design tokens: dark-first with a real light mode, self-hosted Inter + JetBrains Mono, one cyan accent. The UI is built from a small set of shared primitives — `Markdown` (sanitized `react-markdown` + `remark-gfm` + `rehype-sanitize`), `ToolCallCard`, `StatusPill`, `Message`, `AsyncBoundary`, and a slot-based `AppShell` — so the transcript renders real markdown, tool calls collapse into cards with their output, and the layout holds one scrolling conversation with a pinned composer, a free-entry model combobox, a Skills dialog, and a Journal/Tools inspector. See `apps/web/README.md` for the full design-system reference.

It does not duplicate any type from the Worker — every request and response goes through the typed client:

```ts
// apps/web/src/runtime.ts
const client = yield* HttpApiClient.make(AgentApi, { baseUrl: window.location.origin });
```

Send and reset are `@effect/atom-react` mutation atoms; history is a query atom. The streaming endpoint is consumed as a `Stream<StreamPart>`, validated frame-by-frame via `Schema.decodeUnknownEffect(StreamPart)` — if the server adds a new part variant, the client breaks at the schema, not at a `JSON.parse` followed by a `switch`.

In dev, Vite's proxy forwards `/agents/*` to the local Worker at `http://localhost:8787`. In production the FE is served from the same Worker, so `window.location.origin` resolves to the Worker hostname and no CORS is involved.

## Streaming

The **Worker handler** (not the DO) drives the stream: a hop-capped loop runs `LanguageModel.streamText`, encodes each `StreamPart` with `Sse.encoder`, and hands the frames to `HttpServerResponse.stream`. There is no `streamPrompt` method on the `Agent` DO.

Persistence is **write-as-it-happens**, not flush-on-finalizer: the `user-message` event is journaled before the model call and each tool/hop event is appended to the DO journal as it occurs. This is deliberate — `workerd` runs **no** disconnect callbacks (no `abort` event, no stream `cancel()`) at the current compatibility date, so a `Stream.ensuring`/`Effect.ensuring` "persist on disconnect" finalizer would silently never run (see `ISSUES.md`). On a mid-stream client drop, no finalizer fires and the turn is left with no terminal `done` event — a legitimate **parked/incomplete** state that `scripts/verify-journal.ts` reports as PARKED (stream re-attach is #49's territory). The `flushPartialHopText` finalizer in `handlers.ts` covers only mid-hop *failures* (the model API dying between deltas), which interrupt through normal Effect channels and do run finalizers.

On the browser side the same `StreamPart` schema decodes each SSE frame. Unknown tags are filtered out, so a server that emits a new variant won't crash the UI — old clients just stop rendering the new frames.

## Dev

Prerequisite: a local Docker daemon (the `Sandbox` container image builds locally for `dev` and `deploy`). Local secrets go in `.dev.vars` (copy `.dev.vars.example`) — **required before `bun run typecheck` too**: the generated `worker-configuration.d.ts` derives `Env.OPENROUTER_API_KEY` from `.dev.vars`, so a fresh clone without it fails typecheck.

```sh
bun install

# Two terminals (no concurrent runner is wired):
bun run dev                                   # terminal 1 — wrangler dev (Worker at :8787, needs Docker)
bun run --filter @efflux/web dev         # terminal 2 — Vite (FE at :5173, proxies /agents)

bun run typecheck                             # cf-typegen, then tsc --noEmit across the six tsconfigs
bun run build                                 # builds the FE then typechecks the Worker
```

`.claude/effect-smol` is an optional pinned Effect-source submodule for AI-assisted development — `git submodule update --init .claude/effect-smol` to populate it; it is not a build prerequisite.

`bun run typecheck` chains `bun run cf-typegen` (`wrangler types`) first, regenerating the gitignored `worker-configuration.d.ts` from `wrangler.jsonc`. `bun run build` runs the Vite build (`apps/web/dist`), then `tsc --noEmit` against `apps/api/src`. `wrangler.jsonc` declares `assets.directory: "./apps/web/dist"` with `run_worker_first` on `/agents/*` and `/tasks*`, so the same Worker serves both the HttpApi and the built FE on deploy.

## Deploy

First-time provisioning creates the named resources the bindings expect:

```sh
# 1. R2 buckets — skills/roles + per-session workspace tarballs
wrangler r2 bucket create efflux-skills
wrangler r2 bucket create efflux-sessions

# 2. AI Search instance — the KNOWLEDGE_SEARCH binding
wrangler ai-search create efflux-knowledge --type builtin

# 3. Worker secrets — OPENROUTER_API_KEY for model calls; API_TOKEN for the
#    Authorization bearer the FE (VITE_API_TOKEN, inlined at build) must match
wrangler secret put OPENROUTER_API_KEY
wrangler secret put API_TOKEN

# 4. Deploy — needs Docker (builds the Sandbox container image)
bun run deploy
```

The `predeploy` hook runs `bun run build` and `bun scripts/upload-skills.ts` first, so a stale `apps/web/dist` can't ship and R2 skills/roles stay in sync. `wrangler deploy` reads `wrangler.jsonc`, which declares the Worker `efflux`, the `Agent`/`Sandbox`/`Registry` DurableObjects (`Sandbox` is a container built from `apps/api/container/Dockerfile`), the `efflux-skills`/`efflux-sessions` R2 buckets, the `efflux-knowledge` AI Search instance, the cron trigger, and the FE assets. On the first request after a cold deploy the `Sandbox` container spins up from zero instances, so the first tool call can 500 and then succeed on retry (see `ISSUES.md`).

Useful root scripts:

| Script              | What it does                                                     |
| ------------------- | ---------------------------------------------------------------- |
| `bun run dev`       | `wrangler dev` — local Worker + emulated bindings (needs Docker)  |
| `bun run deploy`    | `wrangler deploy` (runs `predeploy` first; needs Docker)          |
| `bun run tail`      | `wrangler tail` — stream Worker logs                              |
| `bun run typecheck` | `cf-typegen` + `tsc --noEmit` across the six tsconfigs          |
| `bun run cf-typegen`| `wrangler types` — regenerate `worker-configuration.d.ts`         |

## The claim

A typical agent-framework "support agent" example is ~30 lines. Efflux is larger — but every line is something you can point at and explain:

| Framework feature                    | Underlying CF primitive   | What we use                              |
| ------------------------------------ | ------------------------- | ---------------------------------------- |
| Persistent session by URL `<id>`     | Durable Object            | native DO binding (`wrangler.jsonc`)     |
| Sandbox                              | CF Containers             | `@cloudflare/containers` `Container` DO  |
| Skills / AGENTS.md                   | R2                        | native R2 binding + `scripts/upload-skills.ts` |
| Model + tools                        | —                         | `@effect/ai-openrouter` + `effect/unstable/ai` |
| Webhook                              | Worker                    | plain Worker entry (`apps/api/src/index.ts`) |
| Typed output                         | Valibot                   | `effect/Schema`                          |
| Secrets                              | —                         | `wrangler secret` + `.dev.vars`          |
| Streaming                            | SSE                       | `Stream` + `HttpServerResponse.stream`   |
| Chat UI                              | —                         | React 19 + Tailwind v4 + shadcn/ui + `@effect/atom-react` + `HttpApiClient` |
| Deploy                               | framework CLI             | `wrangler deploy`                        |

**What you give up:** convenience and a zero-config DX. A framework does auto-wiring you do once here.

**What you gain:**

- No agent-framework lock-in. The runtime is `effect` + `@effect/ai-openrouter` on stock Cloudflare bindings; the console is React + Tailwind + shadcn on the typed `@effect/atom-react` client.
- One schema, two sides. `AgentApi` and `StreamPart` are defined once in `packages/shared` and consumed by the Worker and the FE — the typechecker enforces that they agree.
- Full Effect composition — Layers, Fibers, structured concurrency, OpenTelemetry, retry policies, schema-validated streaming.
- Infra-as-code in the same file tree. `wrangler.jsonc` declares the DOs, R2 bucket, container image, cron, assets, and Worker.
- Mid-stream disconnect leaves consistent state on disk, not a half-written row.
- Testable services. Each piece is a Layer you can swap.

The foundation requires no framework.
