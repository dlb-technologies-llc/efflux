# effect-flue

> **You don't need Flue.** Here's [Flue's Support Agent example](https://github.com/withastro/flue#support-agent) rebuilt in Effect v4 + alchemy-effect, with model choice via OpenRouter. ~450 lines, no framework.

## What's the claim

[Flue](https://flueframework.com) is "The Agent Harness Framework" — Claude Code, but headless and programmable. It bundles:

- Per-instance Durable-Object-backed sessions
- A container or virtual sandbox
- An R2-mounted "filesystem-as-context" for skills
- A model client with tool calling
- Typed structured output via Valibot
- An HTTP trigger surface (`POST /agents/<name>/<id>`)

Every one of those is a primitive you already have access to if you're on Cloudflare + Effect:

| Flue | Underlying CF primitive | What we use |
|---|---|---|
| Persistent session by URL `<id>` | Durable Object | `alchemy/Cloudflare` `DurableObjectNamespace` |
| Sandbox | CF Containers | `alchemy/Cloudflare` `Container` |
| Skills / AGENTS.md | R2 | `alchemy/Cloudflare` `R2Bucket` |
| Model + tools | — | `@effect/ai-openrouter` + `effect/unstable/ai` |
| Webhook | Worker | `alchemy/Cloudflare` `Worker` |
| Typed output | Valibot | `effect/Schema` |
| Secrets | — | `alchemy/Cloudflare` `SecretsStore` |
| Deploy | `flue build` | `alchemy deploy` |

This repo is the proof.

## Side-by-side: the Support Agent

### Flue (~30 lines of agent code)

```ts
// .flue/agents/support.ts
import { getVirtualSandbox } from '@flue/runtime/cloudflare';
import type { FlueContext } from '@flue/runtime';

export const triggers = { webhook: true };

export default async function ({ init, payload, env }: FlueContext) {
  const sandbox = await getVirtualSandbox(env.KNOWLEDGE_BASE);
  const harness = await init({ sandbox, model: 'openrouter/moonshotai/kimi-k2.6' });
  const session = await harness.session();

  return await session.prompt(
    `You are a support agent. Search the knowledge base for articles
     relevant to this request, then write a helpful response.

     Customer: ${payload.message}`,
    { role: 'triager' },
  );
}
```

### This repo (every line is a primitive you already understand)

See [`src/Agent.ts`](./src/Agent.ts) for the agent itself, [`src/Api.ts`](./src/Api.ts) for the Worker entry, and [`alchemy.run.ts`](./alchemy.run.ts) for the stack.

The agent is a `DurableObjectNamespace`. Each `<id>` segment is one DO instance with its own message history, container sandbox, and bindings:

```ts
export default class Agent extends Cloudflare.DurableObjectNamespace<Agent>()(
  "Agents",
  Effect.gen(function* () {
    const skills = yield* Cloudflare.R2Bucket.bind(Skills);
    const apiKey = yield* Cloudflare.Secret.bind(OpenRouterKey);
    const sandbox = yield* Cloudflare.Container.bind(Sandbox);

    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      const container = yield* Cloudflare.start(sandbox);
      // ... build OpenRouter layer, tools, expose prompt() method
    });
  }),
) {}
```

## What's wired

- **Persistent sessions** — DO storage holds the message array under `history`. Same `<id>` continues, new `<id>` starts fresh.
- **Model choice via OpenRouter** — caller picks the model per request. Falls back to `anthropic/claude-sonnet-4-6`.
- **Skills from R2** — `skills/support.md` is uploaded to R2 and loaded on each prompt. Frontmatter stripped, body becomes the system prompt.
- **Container sandbox** — every DO instance starts a [`Sandbox` Container](./src/Sandbox.ts). The model gets a `bash` tool that runs commands inside it.
- **Typed structured output** — every prompt returns `{ text, finishReason, toolCallCount, model, messageCount }` validated through Effect Schema.

## Usage

Set the OpenRouter key, then deploy:

```sh
export OPENROUTER_API_KEY=sk-or-...
pnpm install
pnpm deploy
```

Then talk to it:

```sh
# Start a session, default model
curl https://<your-worker>/agents/support/user-abc \
  -d '{"message": "How do I reset my password?"}'

# Same id continues the conversation
curl https://<your-worker>/agents/support/user-abc \
  -d '{"message": "Thanks. One more question..."}'

# Caller picks the model
curl https://<your-worker>/agents/support/user-abc \
  -d '{
    "message": "Summarize what we discussed",
    "model": "openai/gpt-5.2"
  }'

# Inspect history
curl https://<your-worker>/agents/support/user-abc

# Reset
curl -X DELETE https://<your-worker>/agents/support/user-abc
```

## The honest cost

Flue's Support Agent example is ~30 lines. This repo is ~450 lines. The framework was doing real work for you:

- Auto-wiring DO bindings
- Auto-loading skills from filesystem context
- Auto-resolving models per call
- HTTP routing
- Container lifecycle

**What you give up:** convenience and a zero-config DX.

**What you gain:**

- No framework lock-in. Every line is `effect`, `@effect/ai-openrouter`, or `alchemy`.
- Full Effect composition — Layers, Fibers, structured concurrency, OpenTelemetry, retry policies.
- Infra-as-code in the same file tree as the agent. `alchemy.run.ts` declares the DO namespace, R2 bucket, Container app, Secrets store, and Worker.
- Model choice is just a string from the request payload — no provider abstraction needed.
- Testable services. Each piece is a Layer you can swap.

## What's NOT in this proof

Intentionally skipped to keep the scope honest:

- **Roles / subagents** — Flue's `role` system. Easy to add: parse a second R2 markdown file and overlay system prompts at call time.
- **`task()` child sessions** — would be a separate DO method that opens a detached session inside the same instance.
- **MCP** — out of scope per the brief.
- **Streaming** — would swap `generateText` for `streamText` and return an SSE response.
- **`flue dev` hot-reload** — `alchemy dev` is the equivalent; not identical DX.

Each of these is additive, not foundational. The point of this repo is: **the foundation requires no framework.**

## File map

```
alchemy.run.ts          # Stack: Worker + DO + R2 + Container + SecretsStore
src/
  Agent.ts              # The DurableObjectNamespace — sessions, prompt, tools
  Api.ts                # Worker fetch handler — routing
  Sandbox.ts            # CF Container resource + entry script
  Skills.ts             # R2Bucket resource
  Secrets.ts            # SecretsStore + OpenRouter key
skills/
  support.md            # System prompt + role for the support agent
```
