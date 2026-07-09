# Known issues

## Client disconnect mid-SSE: workerd runs NO disconnect callbacks — design for it

**TL;DR:** When an SSE client drops mid-stream, workerd marks the request
`Canceled` but (at compatibility date 2026-07-01) fires **neither**
`request.signal`'s `abort` event **nor** a prompt `cancel()` on the response
body `ReadableStream`. Effect finalizers (`Stream.ensuring`,
`Effect.ensuring` on forked fibers) therefore never run for the
disconnected request — even work pre-registered via `ctx.waitUntil` can't
help, because the JS that would resolve it never executes. Any
"persist-on-disconnect" design that relies on a finalizer silently does
nothing.

### How it was found (2026-07-08, #36 event journal)

Three designs were deployed and probed live (kill `curl` mid-stream after
25+ non-empty `text-delta` frames, then read the journal):

1. `Effect.ensuring` flush on the forked stream driver — never ran.
2. `Stream.ensuring` flush on the response stream (the slot the pre-journal
   `persistTurn` used) + a `ctx.waitUntil` guard promise resolved by the
   finalizer — never ran. This also means the OLD `persistTurn` never
   actually persisted anything on disconnect; the whole turn (user message
   included) was silently lost pre-journal.
3. A plain `request.source.signal.addEventListener("abort", ...)` that
   synchronously started the DO RPC and registered it with
   `ctx.waitUntil` — the listener never fired.

`wrangler tail` shows the request as `Canceled` with no further logs in all
three cases.

### What actually happens

The server-side producer just keeps running after the client is gone —
verified live: tool-call/tool-result appends and the hop-end batch landed
30+ seconds after the client was killed. Production stops only when the
producer blocks on the filled response queue or the runtime reaps the
context.

### Design consequence (how the journal handles it)

Don't buffer state worker-side and flush at the end — write it as it
happens:

- The `user-message` journal event is appended BEFORE the model call, so a
  disconnected turn always exists in the journal.
- Tool events append inline as parts arrive; hop batches append at hop end.
  Both keep landing after disconnect for as long as the driver survives.
- A turn with no terminal `done`/`error` event is a legitimate journal
  state meaning "parked/incomplete" (`scripts/verify-journal.ts` reports it
  as PARKED; stream re-attach is #49's territory).

The `flushPartialHopText` finalizer in `handlers.ts` covers mid-hop
FAILURES (e.g. the model API dying between deltas) — those interrupt the
stream through normal Effect channels and DO run finalizers. It knowingly
does not cover disconnects.

---

## `Cloudflare.Secret.bind()` from SecretsStore crashes Worker boot

> **Historical (alchemy era).** Resolved by the wrangler migration (#29): alchemy is no longer used. Secrets are now `wrangler secret put OPENROUTER_API_KEY` (deployed) + `.dev.vars` (local).

**TL;DR:** Calling `yield* Cloudflare.Secret.bind(MySecret)` at the Worker
init phase (or the per-request fetch) makes the entire Worker throw `Error:
"[object Object]"` on every request before any user code runs. Switch to a
plain Worker env binding (`env: { KEY: Redacted.make(value) }` in the Worker
props, read back via `Cloudflare.WorkerEnvironment`) and the problem goes
away entirely.

### Stack

- `alchemy@2.0.0-beta.39`
- `effect@4.0.0-beta.66`
- Cloudflare Workers runtime

### Symptoms

- Every request to the Worker returns `error code: 1101` ("Worker threw
  exception"). Includes the `/` route — i.e., the Worker doesn't boot far
  enough to handle anything.
- `wrangler tail` shows `Error: [object Object]` with empty `logs[]`. Same
  diagnostic surface as the `Schema.Class` RPC issue below.
- `Effect.catchCause` / `Effect.tapCause` at the fetch handler never fires —
  the throw happens before any user effect runs.

### What we tried (each fails identically)

```ts
// At Worker init — fails
const apiKey = yield* Cloudflare.Secret.bind(OpenRouterKey)

// Per-request inside fetch — fails the same way
const apiKey = yield* apiKeyClient.pipe(Effect.orDie)
```

Both `Secret.bind` returns a `SecretClient` (an Effect resolving to the
secret value). Yielding it at any point crashes the Worker. The actual
exception is hidden behind alchemy's RPC bridge stringification.

### Fix

Use a plain Worker env binding instead:

```ts
// apps/api/src/Api.ts
import { Redacted } from "effect"

const requireEnv = (key: string): string => {
  const value = process.env[key]
  if (!value) throw new Error(`${key} required`)
  return value
}

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.filename,
    env: {
      OPENROUTER_API_KEY: Redacted.make(requireEnv("OPENROUTER_API_KEY")),
    },
  },
  Effect.gen(function* () {
    return {
      fetch: ...pipe(
        Effect.map((handler) =>
          Effect.gen(function* () {
            const env = yield* Cloudflare.WorkerEnvironment
            const raw = env.OPENROUTER_API_KEY
            const apiKey = Redacted.isRedacted(raw)
              ? Redacted.value(raw)
              : String(raw)
            return yield* handler.pipe(...)
          }),
        ),
      ),
    }
  }),
) {}
```

The key is set at deploy time from `process.env`/`.env`, baked into the
deployed Worker's env, and round-trips back to runtime as a `Redacted` value
on `WorkerEnvironment[KEY]`. Same pattern as eds-connective's backend.

### Why this matters

`SecretsStore` is meant to be the canonical way to manage secrets in alchemy —
it has dedicated `Cloudflare.SecretsStore`, `Cloudflare.Secret`, and
`Cloudflare.Secret.bind` APIs, full docstrings, and the
`cloudflare-secrets-store` example. But in 2.0.0-beta.39 it does not work in
the standard Worker fetch path. There is no error message pointing at this;
the failure looks identical to every other "[object Object]" issue (see
below). Hours of debugging time is the cost.

### Suggested upstream fix

- `Cloudflare.Secret.bind()` should either work end-to-end on a Worker fetch,
  or fail loudly with a typed error explaining the limitation.
- alchemy's RPC bridge should preserve the underlying error message instead
  of `new Error(cause)` where cause becomes `[object Object]`. The example
  `cloudflare-secrets-store` would benefit from a Worker fetch test that
  exercises `yield* apiKey` end-to-end.

---

## `Schema.Class` cannot cross a Cloudflare Durable Object RPC boundary

> **Still active.** This constraint applies equally to native CF DO RPC (post-wrangler-migration) — `structuredClone` at the RPC fence is a Workers-runtime rule, not an alchemy one. Alchemy-specific details below (the `[object Object]` wrapping) are historical.

**TL;DR:** Effect HttpApi handlers that read/write data through a DurableObject
RPC method can't pass `Schema.Class` instances. CF Workers RPC uses
`structuredClone`, which throws `DataCloneError` on class instances. But the
opposite end — HttpApi's response encoder — *requires* a class instance and
rejects the equivalent plain object. The two constraints conflict.

### Stack

- `effect@4.0.0-beta.66`
- `alchemy@2.0.0-beta.39`
- `@effect/ai-openrouter@4.0.0-beta.66`
- Cloudflare Workers runtime (`workerd`), Durable Objects RPC

### Symptoms (in order of debugging surface)

1. **CF Worker 1101 (`Worker threw exception`)** on every request to the
   route. The browser sees a CF error page; `curl` returns `error code: 1101`.
2. **`wrangler tail`** shows the exception as `Error: [object Object]` with
   empty `logs[]`. The cause is a JS Error whose `message` is an object whose
   `toString()` is the default `"[object Object]"` — i.e., something is doing
   `new Error(cause)` on a non-Error cause that doesn't override `toString`.
   This makes the actual error invisible in tail's default output.
3. **`Effect.catchCause` at the Worker entry never fires** — the exception
   originates inside alchemy's RPC bridge (CF's DO RPC client wrapping), which
   sits between the user's handler and the DO. The Effect runtime in the
   handler never sees the throw.
4. Once the surface-level error is past, the *real* errors surface in tail:
   ```
   SchemaError: Expected AgentError, got RpcCallError:
     RPC call to "prompt" failed:
     Could not serialize object of type "PromptRequest".
     (cause: DataCloneError: Could not serialize object of type "PromptRequest".)
   ```
   Then, after fixing the request side:
   ```
   HttpApiSchemaError: Body {
     [cause]: SchemaError: Expected PromptResponse,
       got {..., Symbol(Symbol.dispose): function}
   }
   ```
   Then:
   ```
   HttpApiSchemaError: Body {
     [cause]: SchemaError: Expected PromptResponse, got {plain object}
   }
   ```

### Root cause

Three layers each have a strict opinion about object identity:

1. **Effect HttpApi response encoder** (`HttpApiBuilder.layer`): when an
   endpoint's `success` schema is a `Schema.Class`, the encoder validates that
   the returned value is an instance of that class. A plain `{...}` with the
   right shape is rejected with `Expected PromptResponse, got {...}`.

2. **Effect HttpApi request decoder**: decodes the request payload into a
   `Schema.Class` instance (e.g., `PromptRequest`). Handlers receive an
   actual class instance, not a plain object. The **client side**
   (`HttpApiClient.make`) symmetrically *encodes* the payload via the same
   `Schema.Class` and also requires a class instance, not a plain object —
   passing `payload: { message }` produces `Expected PromptRequest, got
   {"message":"..."}`. Fix: `payload: new PromptRequest({ message })`.

3. **CF Workers RPC across DurableObject boundary**: uses `structuredClone`
   for arguments and return values. `structuredClone` works on plain objects,
   arrays, primitives, etc., but throws `DataCloneError` on class instances
   that don't implement the structured-clone protocol. CF additionally
   attaches a `Symbol(Symbol.dispose)` property to RPC return values for
   resource lifecycle tracking — present even on plain objects that round-trip.

When a handler does:

```ts
.handle("prompt", ({ payload }) => agent.prompt(payload))
```

Where `payload: PromptRequest` (class instance from HttpApi decode) and
`agent.prompt` is a DO RPC method — the class instance can't be cloned, the
call throws `DataCloneError`, alchemy wraps that into `RpcCallError`, which
HttpApi tries to validate against the endpoint's error schema, fails, and
the cascade eventually produces the `[object Object]` Worker exception.

### Minimal reproducer

```ts
// shared/Schemas.ts
export class PromptRequest extends Schema.Class<PromptRequest>("PromptRequest")({
  message: Schema.String,
}) {}
export class PromptResponse extends Schema.Class<PromptResponse>("PromptResponse")({
  text: Schema.String,
}) {}

// shared/AgentApi.ts
export class AgentApi extends HttpApi.make("agent-api").add(
  HttpApiGroup.make("agents").add(
    HttpApiEndpoint.post("prompt", "/agents/:id", {
      params: Schema.Struct({ id: Schema.String }),
      payload: PromptRequest,
      success: PromptResponse,
    }),
  ),
) {}

// apps/api/Agent.ts (DO)
export default class Agent extends Cloudflare.DurableObjectNamespace<Agent>()(
  "Agents",
  Effect.gen(function* () {
    return Effect.gen(function* () {
      return {
        // Accepts PromptRequest; cannot — DataCloneError on the calling side.
        prompt: (input: PromptRequest) =>
          Effect.succeed(new PromptResponse({ text: `echo: ${input.message}` })),
      }
    })
  }),
) {}

// apps/api/handlers.ts
export const AgentHandlers = HttpApiBuilder.group(AgentApi, "agents", (h) =>
  h.handle("prompt", ({ params, payload }) =>
    Effect.gen(function* () {
      const agents = yield* AgentStub
      const agent = agents.getByName(params.id)
      return yield* agent.prompt(payload) // ← DataCloneError at runtime
    }),
  ),
)
```

### Workaround

Shred everything to plain JSON-serializable values at the RPC boundary, then
reconstruct class instances on the way back out to HttpApi.

```ts
.handle("prompt", ({ params, payload }) =>
  Effect.gen(function* () {
    const agents = yield* AgentStub
    const agent = agents.getByName(params.id)
    // 1. Pass a plain object across the RPC boundary (not the PromptRequest
    //    class instance — structuredClone would throw DataCloneError).
    const r = yield* agent.prompt({ message: payload.message })
    // 2. Rebuild a clean class instance on return. CF attaches a
    //    Symbol(Symbol.dispose) to RPC return values; the spread strips it.
    //    HttpApi's response encoder requires an actual PromptResponse instance.
    return new PromptResponse({ text: r.text })
  }),
)
```

The DO's `prompt` method must accept plain `{message: string}` and return
plain `{text: string}` (or an array of plain objects for history). It can
internally use `Schema.decode`/`encode` for validation, but it must hand off
plain values at the RPC fence.

For history-style endpoints that return arrays of `Schema.Class` items, the
DO returns `Array<{role, content}>`, and the handler maps each element back
into `new Message({...})` before wrapping in `new HistoryResponse({...})`.

### What the symptoms hide

The early surface is **maximally unhelpful**:

- Effect.catchCause inside the worker handler **doesn't fire** — the throw is
  before user code, in the RPC bridge.
- `wrangler tail` default formatter prints `Error: [object Object]` with no
  stack — the real error path is buried under several layers of error
  wrapping (`DataCloneError` → `RpcCallError` → `SchemaError` → `[object Object]`).
- The 1101 page tells you to "check Workers Logs" but the logs say the same
  uninformative thing unless you trigger the request while `wrangler tail` is
  already open in `pretty` mode.

It took multiple deployment cycles before the `DataCloneError` line appeared.
A fix that surfaces the underlying cause in the first tail output would save
hours.

### Suggested upstream changes

- **alchemy** (`Cloudflare.DurableObjectNamespace`): when the user's DO method
  signature involves a `Schema.Class`, wrap the call site with a clearer
  error: "DurableObject RPC values must be structuredClone-able. Spread
  Schema.Class instances to plain objects before crossing the RPC boundary."
- **alchemy**: avoid `new Error(cause)` on non-Error causes in the RPC bridge
  — preserve the `DataCloneError` as the thrown value so `wrangler tail`
  surfaces the real message instead of `[object Object]`.
- **effect** (`HttpApiBuilder`): when the encoder rejects a plain object that
  *shape-matches* the schema, include a hint in the error: "the value is
  structurally correct but is not an instance of `<SchemaClass>` — pass
  `new SchemaClass({...})` instead of a plain object literal."
- **CF Workers documentation**: explicitly note that `Symbol.dispose` is
  attached to RPC return values, with guidance on how to strip it for callers
  that validate schema shape (HttpApi, Zod, ArkType, etc.).

### Current state of this repo

`apps/api/src/Agent.ts` is currently a diag stub that echoes the input. The
full DO (Container + OpenRouter + Skills + Secrets) was reverted while
isolating the bug. Re-adding each piece must respect the rule: **plain
objects cross the DO RPC fence; class instances live on either side, never
in transit.**

---

## Alchemy registers Policies; you must also provide Live layers

> **Historical (alchemy era).** Resolved by the wrangler migration (#29): alchemy is no longer used — bindings come straight from `wrangler.jsonc`, and there is no Policy/Live layer split.

**TL;DR:** `Cloudflare.providers()` (wired up by `Alchemy.Stack` in
`alchemy.run.ts`) registers `Binding.Policy` services — deploy-time metadata
describing **how** to wire each binding kind — but it does **not** auto-merge
the runtime `*Live` layers those bindings depend on. Every binding kind your
Worker init effect actually uses (`Cloudflare.R2Bucket.bind`,
`Cloudflare.cron(...).subscribe`, …) needs its corresponding `*Live` layer
explicitly provided via `Effect.provide(Layer.mergeAll(...))` on the Worker
init effect. Otherwise typecheck fails with a `Property
'...BindingPolicy' is missing in type 'Context.Context<...>'` error pointing
at a service you never imported.

### Stack

- `alchemy@2.0.0-beta.39`
- `effect@4.0.0-beta.66`
- Cloudflare Workers runtime

### Symptoms

- TypeScript error of the form:
  ```
  Property '__effect-smol/.../R2BucketBindingPolicy' is missing in type
  'Context.Context<...>'
  ```
  (or `CronEventSourcePolicy`, or any other `*Policy` service) when the
  Worker init effect calls `Cloudflare.R2Bucket.bind(<bucket>)` or
  `Cloudflare.cron(<expr>).subscribe(<handler>)`.
- The missing service name references a `*Policy` symbol the user never
  directly imported. It's an internal alchemy service registered as part of
  `Cloudflare.providers()`'s ambient context.
- The error surfaces at typecheck — not at runtime — because the binding
  call's `R` channel demands the `Policy` service. Without the matching
  `*Live` layer in scope to satisfy that requirement, the Worker init
  effect's context isn't fully discharged.

### Root cause

`alchemy.run.ts` constructs the deploy program with `Alchemy.Stack` and
`Cloudflare.providers()`. That provider call registers `Binding.Policy`
services for every supported binding kind (R2Bucket, CronEventSource,
DurableObjectNamespace, etc.) so the deploy-side machinery knows **how** to
wire bindings into the deployed Worker manifest.

But the runtime side — the layers that actually implement the Effect-side
binding APIs at Worker boot (`R2BucketBindingLive`, `CronEventSourceLive`,
…) — is **not** auto-merged into the Worker init effect's context. Each
binding kind your Worker uses requires its `*Live` layer to be explicitly
provided. If you call `Cloudflare.R2Bucket.bind(MyBucket)` inside the Worker
init `Effect.gen`, the binding's `R` channel includes
`R2BucketBindingPolicy`, and without `R2BucketBindingLive` provided, the
init effect's context is incomplete and typecheck fails.

### Fix

Provide every `*Live` layer your worker's bindings need on the Worker init
effect itself, via `Effect.provide(Layer.mergeAll(...))`. From
`apps/api/src/Api.ts:162-168`:

```ts
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.R2BucketBindingLive,
        Cloudflare.CronEventSourceLive,
      ),
    ),
  ),
) {}
```

Known `*Live` layers and the binding calls that require them:

- `Cloudflare.R2BucketBindingLive` — required when the Worker init effect
  uses `Cloudflare.R2Bucket.bind(<bucket>)`.
- `Cloudflare.CronEventSourceLive` — required when the Worker init effect
  uses `Cloudflare.cron(<expression>).subscribe(<handler>)`.

This list is open-ended. Other `*Live` layers will surface as the same
"`*Policy` missing" typecheck-error class when their corresponding binding
kind is used (KV, D1, Queues, Durable Objects, Workflows, etc.). The fix is
always the same shape: add the matching `*Live` to the `Layer.mergeAll(...)`
argument.

### Why this matters

This is the third trap in the same family as the two issues above
(`Cloudflare.Secret.bind()` from SecretsStore crashes Worker boot` and
`Schema.Class cannot cross a Cloudflare Durable Object RPC boundary`):
alchemy's API surface for Cloudflare bindings looks self-contained, but
each binding kind has a hidden runtime dependency the user has to wire up
by hand. The previous two issues surfaced at runtime as opaque `[object
Object]` Worker exceptions; this one surfaces at typecheck, which is
strictly better — but the error message points at an internal `*Policy`
service the user never imported, which still costs time to map back to "I
need to add `<Kind>BindingLive`."

### Suggested upstream fix

- `Cloudflare.providers()` (or `Alchemy.Stack`) should provide the matching
  runtime `*Live` layers alongside each `*Policy` it registers, so a binding
  call that typechecks at the Policy level also has its runtime context
  satisfied automatically.
- Failing that, the `R` channel of each `Cloudflare.<Kind>.bind` /
  `Cloudflare.cron(...).subscribe` API should reference the `*Live` service
  by a user-visible name with a docstring pointing at the matching `*Live`
  layer to provide.

---

## Effect AI's `LanguageModel.generateText` / `streamText` run ONE round per call

**TL;DR:** `LanguageModel.generateText({ prompt, toolkit })` does **not**
auto-loop multi-hop tool calls. It runs exactly **one** round — model
inference, tool-call resolution, tool-result attachment — and returns. If
`response.finishReason === "tool-calls"`, the model wanted to continue but
your code has to drive the next iteration: concatenate
`Prompt.fromResponseParts(response.content)` onto the prompt and call
`generateText` again until `finishReason !== "tool-calls"` (or a hop cap
trips). `streamText` has the same semantics — the part stream ends after
that round's tool-result parts. Without a loop, the model emits "Let me
call the tool for you!", invokes the tool, then ends the call before the
tool result ever reaches the user. Tracked against PR #24 (commit
`e243c3fb`); fix lives in `apps/api/src/handlers.ts:124-180` (prompt loop)
and `apps/api/src/handlers.ts:264-330` (stream loop).

> **Re-verified at `effect@4.0.0-beta.94` (2026-07-08, #30 bump):** still no
> native multi-hop — `LanguageModel.generateText` resolves tool calls exactly
> once (`LanguageModel.ts` ~:1185); no `maxSteps`-style option exists in
> `unstable/ai`. The manual loop (now centralized via `AgentLoop.ts`) remains
> required.

### Stack

- `effect@4.0.0-beta.66`
- `alchemy@2.0.0-beta.39`
- Cloudflare Workers runtime

### Symptoms

- The assistant replies with something like "Let me call the tool for
  you!" or "I'll look that up now." then the response ends. The model
  invoked the tool, the toolkit ran it, the result was attached to the
  conversation — but the assistant never got a chance to *speak about*
  the result.
- `response.finishReason === "tool-calls"` on the returned `AiResponse`.
  This is the model telling you "I want to continue after seeing the tool
  output," not "I'm done."
- In the streaming handler, the SSE stream emits a `finish` frame with
  `reason: "tool-calls"` immediately after the tool-result parts, then
  closes. The FE sees a terminal `done` and stops listening.
- No error is raised. The call "succeeds." Everything looks fine in
  `wrangler tail`. The only signal is the assistant text being a
  pre-tool-call announcement instead of a post-tool-call answer.

### Root cause

`LanguageModel.generateText` (`node_modules/.../effect/src/unstable/ai/LanguageModel.ts`,
the `generateContent` implementation) is a single-round primitive:

1. Send the prompt to the provider.
2. If the response includes tool calls, resolve them via the toolkit and
   attach `tool-result` parts to `response.content`.
3. Return.

There is no internal `while (finishReason === "tool-calls")` loop. The
toolkit param controls **which tools the model may call**, not whether
the runtime will keep calling the model after results land. `streamText`
matches — once the tool-result parts have been pushed into the stream,
the stream completes.

### Fix

Wrap `generateText` in an explicit hop-capped loop, concatenating the
prior round's response parts onto the prompt each iteration. From
`apps/api/src/handlers.ts:124-180`:

```ts
const MAX_TOOL_HOPS = 8
const loop = Effect.gen(function* () {
  let promptValue: Prompt.Prompt = Prompt.make(messages)
  let finalText = ""
  let finalFinishReason: AiResponse.FinishReason = "unknown"

  for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
    const response = yield* LanguageModel.generateText({
      prompt: promptValue,
      toolkit: AgentToolkit,
    })
    finalText = response.text
    finalFinishReason = response.finishReason

    if (response.finishReason !== "tool-calls") break

    // Feed the assistant tool-call message + tool-result messages back
    // into the prompt so the next iteration lets the model see what its
    // tool calls returned.
    promptValue = Prompt.concat(
      promptValue,
      Prompt.fromResponseParts(response.content),
    )
  }

  return { finalText, finalFinishReason }
})
```

For **streams**, recursive `Stream` type inference is painful (each hop's
`Stream` carries its own `R`/`E`, and `Stream.flatMap`-ing them
sequentially across an unknown hop count fights the type system). Use a
**queue-driven driver fiber** instead:

1. Allocate a bounded `Queue` of `AiResponse.StreamPart`.
2. Fork a driver effect that runs the hop loop: for each hop, run
   `streamText(...).pipe(Stream.runForEach(...))`, collect parts, filter
   out intermediate `finish: tool-calls` frames, offer the rest into the
   queue.
3. After the loop, `Effect.ensuring(Queue.end(queue))` closes the queue;
   `Effect.tapCause((c) => Queue.failCause(queue, c))` propagates
   failures.
4. Return `Stream.fromQueue(queue)` to the SSE pipeline.

Full implementation at `apps/api/src/handlers.ts:264-330`. The FE sees a
single continuous stream with exactly one terminal `done` frame, even
though the driver may have made N round-trips to the model under the
hood.

### Why this matters

The original PR #24 plan assumed `generateText({ prompt, toolkit })`
would auto-loop until the model was satisfied — that passing a toolkit
meant "let the model use these tools until it has enough information to
answer." That assumption is wrong, and the failure mode is silent: no
error, no warning, just an assistant that announces what it's about to
do and then hangs up before doing it. The discovery came from reading
the `generateContent` implementation after watching the symptom; nothing
in the public type signature of `generateText` hints that the consumer
owns the loop.

This is a foot-gun anywhere `toolkit:` is used. Any handler that wires
tools into an Effect AI call needs an explicit hop loop, or its
multi-step tool flows will silently degrade to one-shot announcements.

### Suggested upstream fix

- Add a `maxToolHops` (or `multiStep: true`) option to
  `LanguageModel.generateText` / `streamText` that runs the loop
  internally with a sensible default cap, matching the Vercel AI SDK's
  `maxSteps` behavior.
- At minimum, surface a clear docstring on `generateText` /
  `streamText` stating "this runs one round per call; if
  `finishReason === 'tool-calls'`, the caller must concatenate
  `Prompt.fromResponseParts(response.content)` and call again."

---

## Effect ships an MCP *server*, not a client — we hand-rolled the JSON-RPC Streamable-HTTP transport

**TL;DR:** `effect/unstable/ai` ships `McpServer.ts` (expose *your* toolkit
as an MCP server) and `McpSchema.ts` (the protocol modelled as `Rpc.make`
classes), but NO MCP *client*. To CONSUME external MCP servers,
`apps/api/src/Mcp.ts` is a hand-written JSON-RPC 2.0 Streamable-HTTP client
that still decodes replies with the canonical `McpSchema` result classes
(`InitializeResult`, `ListToolsResult`, `CallToolResult`). Every transport
quirk below cost real debugging when it was missed.

### Transport quirks (`apps/api/src/Mcp.ts`)

- **Two reply encodings.** One request may come back as `application/json`
  OR `text/event-stream` — branch on the response `content-type` and handle
  both (`readReply`). For SSE, stop reading at the frame whose JSON-RPC `id`
  matches the request and cancel the reader; do NOT drain the stream, or a
  server that holds the channel open after replying hangs to the 10s
  timeout.
- **Echo the session + protocol headers on EVERY post-init request.**
  `Mcp-Session-Id` (captured from the `initialize` response headers) and
  `MCP-Protocol-Version: <negotiated>` must ride on every subsequent
  request — INCLUDING the `notifications/initialized` notification. Some
  servers 400 without them.
- **Handshake order.** `notifications/initialized` must be sent AFTER
  `initialize` and BEFORE the first `tools/list`.
- **Follow redirects, then re-validate the destination (SSRF).** Real servers
  307/308 to their canonical path, so the fetch uses `redirect: "follow"`
  (`redirect: "manual"` breaks the handshake). But `follow` means the initial
  `isBlockedHost` check on `server.url` no longer covers the FINAL host — a
  public URL that redirects to a private/internal host would otherwise sail
  through. `sendFetch` therefore re-checks `isBlockedHost(response.url)` after
  every fetch and fails closed. Residual (accepted for v1): the redirected
  request still *reaches* the internal host once before we reject its response;
  full per-hop revalidation (like `web_fetch` in `Tools.ts`) is the follow-up
  hardening. MCP URLs are operator-configured, not model-chosen, so the blast
  radius is smaller than `web_fetch`'s.
- **Read the JSON-RPC `.error` object, not just `.result`.** A well-formed
  error envelope carries no `result`; treating a missing `.result` as
  success yields an opaque `undefined`-decode failure instead of the
  server's real message. `resultOf` maps `.error` to an `McpError`
  explicitly and fails on an envelope with neither.
- **`CallToolResult` may carry binary.** `ImageContent`/`AudioContent`
  blocks decode `data` as `Uint8Array`, which trips strict decode.
  `callTool` decodes strict first (`flattenStrict`), then falls back to a
  lenient text-only extraction (`flattenLenient`), so a binary block
  degrades to a placeholder instead of failing the whole call.

### Toolkit side (`apps/api/src/SessionToolkit.ts`)

Discovered tools become `Tool.dynamic(...)` in JSON-Schema mode, namespaced
`mcp__<server>__<tool>`, and folded into the session toolkit via
`Toolkit.merge`. Two non-obvious requirements:

- Each dynamic tool MUST be annotated `.annotate(Tool.Strict, false)` — the
  server's raw JSON Schema will not survive a provider's strict-schema
  validation otherwise.
- The handler MUST `Effect.catchTag("McpError", ...)` the transport failure.
  `McpError` is neither the tool's declared `Failure` nor an `AiError`, so
  an uncaught one fails typecheck at `mcpToolkit.toLayer(handlers)`.

Discovery runs per-turn and degrades gracefully: `discoverServer` catches
every per-server failure (SSRF reject, handshake error, dead/slow server) to
a warning plus an empty tool set, so a broken server contributes zero tools
and never fails the turn.

### Approval-continuation edge

`reconstructForContinuation` rebuilds a parked turn's continuation prompt by
tool NAME + `approvalId`/`toolCallId` — never Effect's internal `tool.id` —
so a parked MCP tool-call survives per-turn re-discovery and resumes. BUT if
the server is unreachable at `/approve` time, the freshly rebuilt toolkit
lacks that tool and the runtime raises `AiError.ToolNotFoundError`: the
approved action is lost. An MCP tool's approval is only as durable as the
server's availability at resume time.
