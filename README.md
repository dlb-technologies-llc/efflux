# effect-flue

> A deployable Cloudflare agent runtime built from Effect v4 + alchemy-effect primitives. No framework required.

[Flue](https://flueframework.com) bills itself as "The Agent Harness Framework" — Claude Code, but headless and programmable. Every primitive it ships (per-session DOs, R2-backed skills, a container sandbox, a model client, an HTTP trigger surface) is something you already have on Cloudflare + Effect. This repo proves it: a complete Support Agent with streaming chat UI, every line written in `effect`, `@effect/ai-openrouter`, `@effect/atom-react`, or `alchemy`.

## What's in here

```
alchemy.run.ts            # Stack: Worker + DO + R2 + Container + SecretsStore
apps/
  api/                    # Cloudflare Worker (HttpApi + DurableObject + Container)
    src/
      Api.ts              # Worker class — composes HttpApi + serves the FE
      Agent.ts            # DurableObjectNamespace — sessions, prompt, streamPrompt
      handlers.ts         # HttpApi handlers (prompt, history, reset, stream)
      Sandbox.ts          # CF Container resource + entry script
      Skills.ts           # R2Bucket resource
      Secrets.ts          # SecretsStore + OpenRouter key
  web/                    # Vite + React FE (chat UI)
    src/
      App.tsx             # Layout + transcript
      atoms.ts            # @effect/atom-react Query + Mutation atoms
      runtime.ts          # Effect runtime + HttpApiClient
      components/         # Chat UI components
packages/
  shared/                 # HttpApi definition, schemas, error types
    src/                  # AgentApi, Message, PromptResponse, StreamPart, ...
pnpm-workspace.yaml
tsconfig.base.json
```

## The architecture

The Worker owns a single HttpApi defined in `@effect-flue/shared`. The same `HttpApi` shape is used three ways:

1. Server: `HttpApiBuilder.layer(AgentApi)` mounts handlers in `apps/api/src/handlers.ts`.
2. Client: `HttpApiClient.make(AgentApi, …)` in `apps/web/src/runtime.ts` gives the FE a fully typed call surface.
3. Stream contract: `StreamPart` is a tagged union; every SSE frame is `Schema.encodeSync(StreamPart)` on the server and `Schema.decodeUnknownEffect(StreamPart)` on the client.

```
┌───────────────────────┐                  ┌────────────────────────────────┐
│   Browser (React)     │   HTTP / SSE     │   Cloudflare Worker (Api)      │
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

```sh
pnpm install

# Two terminals (no concurrent runner is wired):
pnpm dev                                # terminal 1 — alchemy dev (Worker at :8787)
pnpm --filter @effect-flue/web dev      # terminal 2 — Vite (FE at :5173, proxies /agents)

pnpm typecheck                          # tsc --noEmit across all workspaces
pnpm build                              # builds the FE then typechecks the Worker
```

`pnpm build` first runs the Vite build (`apps/web/dist`), then `tsc --noEmit` against `apps/api/src`. The web build is what gets shipped to the Worker as static assets (see the note in `alchemy.run.ts` — the wiring is split between this stack and the Worker class definition).

## Deploy

```sh
export OPENROUTER_API_KEY=sk-or-...
pnpm deploy
```

The `predeploy` script runs `pnpm build` first, so a stale or missing `apps/web/dist` can't ship. `alchemy deploy` reads `alchemy.run.ts` at the repo root, which yields the SecretsStore, OpenRouter key, R2 bucket, Skills, and the Worker (which itself binds the `Agents` DurableObjectNamespace and the `Sandbox` Container).

Useful root scripts:

| Script             | What it does                                    |
| ------------------ | ----------------------------------------------- |
| `pnpm dev`         | `alchemy dev` — local Worker + emulated bindings |
| `pnpm deploy`      | `alchemy deploy` (runs `predeploy` first)        |
| `pnpm destroy`     | `alchemy destroy` — tear down the stack          |
| `pnpm tail`        | `alchemy tail` — stream Worker logs              |
| `pnpm typecheck`   | `pnpm -r typecheck` across every workspace      |

## The claim

The original Flue Support Agent example is ~30 lines. This repo is larger — but every line is something you can point at and explain:

| Flue                                 | Underlying CF primitive   | What we use                              |
| ------------------------------------ | ------------------------- | ---------------------------------------- |
| Persistent session by URL `<id>`     | Durable Object            | `alchemy/Cloudflare` `DurableObjectNamespace` |
| Sandbox                              | CF Containers             | `alchemy/Cloudflare` `Container`         |
| Skills / AGENTS.md                   | R2                        | `alchemy/Cloudflare` `R2Bucket`          |
| Model + tools                        | —                         | `@effect/ai-openrouter` + `effect/unstable/ai` |
| Webhook                              | Worker                    | `alchemy/Cloudflare` `Worker`            |
| Typed output                         | Valibot                   | `effect/Schema`                          |
| Secrets                              | —                         | `alchemy/Cloudflare` `SecretsStore`      |
| Streaming                            | SSE                       | `Stream` + `HttpServerResponse.stream`   |
| Chat UI                              | —                         | React + `@effect/atom-react` + `HttpApiClient` |
| Deploy                               | `flue build`              | `alchemy deploy`                         |

**What you give up:** convenience and a zero-config DX. Flue does auto-wiring you have to do once here.

**What you gain:**

- No framework lock-in. Every line is `effect`, `@effect/ai-openrouter`, `@effect/atom-react`, or `alchemy`.
- One schema, two sides. `AgentApi` and `StreamPart` are defined once in `packages/shared` and consumed by the Worker and the FE — the typechecker enforces that they agree.
- Full Effect composition — Layers, Fibers, structured concurrency, OpenTelemetry, retry policies, schema-validated streaming.
- Infra-as-code in the same file tree. `alchemy.run.ts` declares the DO namespace, R2 bucket, Container app, Secrets store, and Worker.
- Mid-stream disconnect leaves consistent state on disk, not a half-written row.
- Testable services. Each piece is a Layer you can swap.

The foundation requires no framework.
