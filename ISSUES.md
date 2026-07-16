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
- The streaming driver (`apps/api/src/StreamingTurn.ts`) is now DETACHED
  from the request fiber: it runs via `Effect.runPromise` on a fresh root
  fiber, and its completion is registered with `ctx.waitUntil` (threaded
  per-request through the `WaitUntil` service — `apps/api/src/index.ts` +
  `WaitUntil.ts`). A disconnected turn therefore runs to a terminal instead
  of stalling. The response sink is `Queue.sliding(256)`, so `Queue.offer`
  never blocks the driver on a gone client via backpressure.
- The driver now OWNS its terminals: it journals the terminal `done` (in
  the hop loop) and, on failure, the terminal `error` (via
  `journalTurnError`), and it snapshots the workspace — because the response
  pipeline no longer runs once the client is gone. (Previously the terminal
  `error` + snapshot lived on the response stream, which silently did
  nothing on disconnect — the same trap that lost the pre-journal
  `persistTurn`.)
- A turn STILL ending with no terminal `done`/`error` is now the narrow
  reaped-before-finish case; `scripts/verify-journal.ts` still reports it as
  PARKED. Recovery is `GET /agents/:name/:id/attach`
  (`apps/api/src/AttachStream.ts`): it replays journaled frames as SSE from
  the resume cursor — `Last-Event-ID` header, else `?after=`, else the
  LATEST turn in full — then live-tails the journal until the followed turn
  terminates, parks, or goes stale. That is how a client recovers "zero
  lost frames" after a disconnect: it reads the journal, not the dropped
  socket. (Stream re-attach was #49.)

**Residual tradeoff (honest):** the `sliding` sink is not free. If a
still-CONNECTED client falls more than 256 frames behind, the queue drops
its OLDEST buffered frames. Those dropped frames are un-journaled
`text-delta`s (tokens) — recoverable only as the hop's full assistant text
via `GET /history` or a reattach, NOT per-token. That token-loss is the
necessary price of never stalling the driver on a gone client.

The `flushPartialHopText` finalizer (now in `StreamingTurn.ts`) covers
mid-hop FAILURES (e.g. the model API dying between deltas) — those interrupt
the driver through normal Effect channels and DO run finalizers, and the
driver's `tapCause` journals the terminal `error` and snapshots alongside
it. It knowingly does not cover disconnects; the detached driver +
`ctx.waitUntil` do.

### Verified live (2026-07-10, #49 deploy)

Confirmed against the running worker, not on paper:

- **Survival + reattach works.** A 3-hop turn (each hop a `sleep 6` Bash
  call) whose client was killed 7s in — right after the first `tool-call`
  frame, before that hop's tool even finished — ran ALL three hops to a
  terminal `done` with no client attached, and `GET /attach` from the last
  seen `Last-Event-ID` replayed every intervening frame (tool results, later
  hops, assistant text, `done`) with zero gaps. `ctx.waitUntil` demonstrably
  extends the isolate past the response: a longer turn was still journaling
  its 3rd `tool-call` ~30s+ after disconnect, well beyond the ~30s natural
  survival window this file documents above.
- **There IS a `ctx.waitUntil` wall-clock ceiling.** A turn of 3×`sleep 14`
  (~42s of tool time) survived the disconnect and journaled through its 3rd
  `tool-call`, then STALLED — the 3rd tool result and `done` never landed
  (the container had already run two `sleep 14`s fine, so it is the isolate
  being reaped, not the sandbox). Practical ceiling observed on this plan:
  a detached turn reliably completes only if it finishes within roughly
  40–50s of wall-clock after the detach point; longer turns can be reaped
  mid-flight, leaving the journal terminal-less (a genuinely-reaped turn is
  the one case `/attach`'s ~150s staleness cutoff exists to bound). This is
  the inherent limit of the Worker-side + `waitUntil` approach (the DO has
  no AI layer, so moving the driver DO-side was out of scope for #49).

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

**The RPC TYPE transform also widens `typeof X.Encoded` — derive fence-crossing
plain types with `Pick`, not the encoded alias.** This is a *compile-time* trap
distinct from the runtime `DataCloneError` above. A DO method whose return (or a
per-turn service type fed from that return) is annotated `typeof SomeSchemaClass.Encoded`
will NOT typecheck against the RPC-proxied value: Cloudflare's DO-stub type transform
collapses the opaque Effect encoded type (`ReadonlySide<Schema.Literals<…>>`) back to
`string`, so a `Schema.Literals` field silently becomes `string` across the fence and
fails to assign to the encoded-alias target. Derive the plain shape with
`Pick<SomeSchemaClass, "field" | …>` instead — it yields a plain
`{ readonly field: "a" | "b" }` that survives the transform and stays schema-derived
(no re-listed literals). (prev1-quality-refactor #90: `PlainTodo = typeof TodoItem.Encoded`
reddened the wave typecheck on `TodoStore.read`/`latestTodos`;
`Pick<TodoItem, "content" | "status">` fixed it. `history()`/`PlainMessage` only compiled
because its consumer `composeMessages` takes a plain union, which masked the same hazard —
so a passing sibling is NOT evidence the encoded alias is fence-safe.)

**A DISCRIMINATED-UNION DO-method return trips the type transform a second, distinct
way — the provider layer needs an explicit `Effect.promise<T>` type arg.** A DO method
returning `Promise<{a}|{b}>` (e.g. a `{ id; nextRunAt } | { error }` result) is proxied as
a UNION of Promise-intersections — `(Promise<{a}&Disposable>&Pick<…>) | (Promise<{b}&Disposable>&Pick<…>)`.
TypeScript will NOT collapse that union into a single `PromiseLike<{a}|{b}>` when inferring
the type parameter of `Effect.promise(() => stub.method())` at the layer that wraps the RPC:
it infers the FIRST arm and reds on the second (`Type '{b}&Disposable' is not assignable to
type '{a}&Disposable'`). Fix: give `Effect.promise` an explicit type argument —
`Effect.promise<{a}|{b}>(() => stub.method())` — matching the union the DO method declares.
This is unrelated to the `structuredClone` runtime rule and the `typeof X.Encoded` widening
above; all three are separate DO-fence traps. (full-cron-scheduling #121: `createScheduledJob`'s
`{ id; nextRunAt } | { error }` return reddened the wave typecheck at `AgentLoop.ts`'s
`makeScheduledJobsLayer`; an explicit `Effect.promise<CreateScheduledJobResult>(…)` fixed it,
and the union was extracted to one shared `type` referenced by the DO method, the `ScheduledJobs`
service, and the layer.)

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

## Renamed `remote: true` binding (`ai_search`) blocks `wrangler dev` boot

### Symptoms (2026-07-10, #85 rebrand)

After renaming the `ai_search` `instance_name` in `wrangler.jsonc` (to `efflux-knowledge`), `wrangler dev` fails to start:

```
✘ [ERROR] AI Search binding 'KNOWLEDGE_SEARCH' references instance 'efflux-knowledge' in namespace 'default' which was not found.
✘ [ERROR] Failed to start the remote proxy session. Failed to obtain a preview token.
```

`wrangler dev` fetches a preview token for every `remote: true` binding at startup, so a renamed-but-not-yet-created instance aborts the whole boot — even though the binding is only consumed lazily per-request (`Layer.succeed(KnowledgeSearch, env.KNOWLEDGE_SEARCH)` in `index.ts`), never at module load.

### Fix

Provision the instance first — `wrangler ai-search create efflux-knowledge --type builtin` — or, for a quick local smoke before it exists, comment the `ai_search` block out of the worktree `wrangler.jsonc` (uncommitted; the committed config keeps it). Only the knowledge-search feature then no-ops.

## `Sandbox` container cold-starts at zero instances — the first tool call 500s

### Symptoms (2026-07-10, #85 first deploy)

Immediately after a fresh deploy, the first Bash (tool) turn returns `HTTP 500` (`error code: 1101`, a Worker exception); a retry seconds later returns `200`. Non-tool turns (pure model + markdown) succeed on the first try.

### Root cause

The `Sandbox` container application deploys with `instances: 0` and scales up on demand. The very first `/exec` request triggers a container cold start and can throw before the container is ready. This is a warm-up artifact, NOT a code bug — subsequent calls hit the warm container.

### Fix

None needed — retry. If a cold first call must not fail, warm the container with a throwaway tool turn right after deploy (fold it into the `/efflux-verifying` post-deploy smoke).

## Renaming the repo folder mid-session breaks Claude skill/agent discovery

### Symptoms (2026-07-10, #85 rebrand)

Renaming the checkout directory while a Claude Code session is live orphaned the harness's `/efflux-*` skill and `efflux-task-executor` agent lookup — the session's project-root path no longer existed, so invocations failed with "Unknown skill". The sibling `git` worktrees under `.claude/worktrees/*` also went `prunable`, since their recorded absolute paths still pointed at the old folder name.

### Fix

- Re-link the moved worktrees with `git worktree repair <new-worktree-paths>` — with no args it can't find them at their old recorded locations, so pass the NEW paths; then `git worktree prune` clears any orphaned admin entries.
- For the skills: run them from their files (`.claude/skills/<name>/SKILL.md`) for the rest of the session, or start a FRESH session at the new path, which restores the `/efflux-*` commands and the `efflux-task-executor` agent.
- Prefer renaming the checkout folder BETWEEN sessions, never during one.

## Iterative testing against the deployed worker instead of `bun run dev` produced a real Container bill

### Symptoms (2026-07-15, feature-generating #98)

A routine feature PR's verification pass — plus the user's own manual testing of the new feature afterward — was driven entirely against the shared deployed worker (`https://efflux.david-0e2.workers.dev`) rather than `bun run dev` locally: many `bun scripts/agent.ts` smoke sessions, dozens of `curl`s against live endpoints, two full `bun run deploy` cycles, and an extended interactive chat session in the browser, all pointed at the deployed URL. The Cloudflare billing dashboard afterward showed **`Container Memory, per GiB-Second`: 9.68M billable units → $23.97** for the billing period — the single largest line item by far. `9.68M GiB-seconds ÷ 4 GiB (the `standard-1` instance's fixed memory) ÷ 3600 ≈ 672 cumulative instance-hours` — the sum of every container instance's alive time across every session, not one container running continuously (Cloudflare's own docs confirm `sleepAfter` actually terminates the instance — `SIGTERM` then `SIGKILL` after 15 min — it does not just idle it).

### Root cause

`/efflux-verifying` already documented "default to LOCAL, deploy only for the final pass" (for speed and to sidesteps deploy races/edge caching), but that guidance wasn't followed here — verification went straight to the deployed worker, and follow-up debugging (an auth incident, then this cost investigation) compounded it with more live-worker round-trips instead of local reproduction. Two multiplying factors made this expensive rather than merely slow: `Sandbox`'s `sleepAfter` was `10m` (each session's container stayed billed for up to 10 minutes after every burst of activity, not just its actual working time), and `standard-1` (4 GiB memory) was used for both `Sandbox` and the new `Runner` without checking whether a smaller instance type (`lite` 0.25 GiB / `basic` 1 GiB) would have sufficed for either workload.

### Fix

- `Sandbox.sleepAfter` shortened `10m` → `1m` (`apps/api/src/Sandbox.ts`) — cuts idle-billed time per session ~10x while still covering back-to-back tool calls within one active turn (typically seconds apart) without cold-starting between them.
- `/efflux-verifying`, `/efflux-executing`, and `/efflux-planning` all now state the local-first default more forcefully, including "this applies to pointing a human at the app to manually try a change too" — not just the agent's own checklist.
- **Not done here, worth doing if the bill keeps climbing:** right-size `standard-1` down to `basic` for `Sandbox`/`Runner` (an unverified ~4x memory-cost cut — confirm `basic`'s 1 GiB is actually sufficient for real workloads before switching), and/or destroy `Sandbox` explicitly at the end of every turn instead of relying on `sleepAfter` at all (zero idle billing, but a cold start — and today, no automatic retry — on every single turn, not just after a real gap in activity).

### Why this matters

Cloudflare Container memory bills for the full **provisioned** duration, not actual use (confirmed via Cloudflare's pricing docs) — CPU bills for active use only, but memory and disk do not. Combined with a keep-warm idle window, a bursty, low-utilization workload (a chat agent's occasional Bash calls) can rack up idle-billed time far out of proportion to real work, and — because `wrangler dev` runs Containers entirely through the local Docker daemon with zero Cloudflare billing — none of this shows up during local iteration at all. The bill is the first signal, well after the fact, unless local-first is actually followed.

## `CREATE TABLE IF NOT EXISTS` never migrates an existing table — a new column on an existing table needs its own `ALTER TABLE`

### Symptoms (2026-07-15, feature-generating #98)

Added a `stdout_excerpt` column to an `Agent` DO's `scheduled_job_runs` table (a `CREATE TABLE IF NOT EXISTS ... stdout_excerpt TEXT ...` edit to the constructor). Every DO instance whose table had already been created by an EARLIER version of the constructor — i.e. any session that had already run a scheduled job once before this column was added — immediately started throwing on every subsequent write/read referencing the column:

```
Uncaught Error: table scheduled_job_runs has no column named stdout_excerpt: SQLITE_ERROR
```

Thrown from inside the DO's own `alarm()` handler (via `#recordJobRun`), on every alarm firing for that job, repeatedly (Cloudflare retries a throwing alarm handler with backoff, so the same error logs over and over rather than failing once).

### Root cause

`CREATE TABLE IF NOT EXISTS` only handles the case where the table doesn't exist yet — it is a no-op against a table that already exists, columns and all. It does NOT reconcile an existing table's schema with a newer `CREATE TABLE` statement. A DO's SQLite storage is durable across the constructor running again on every future wake-up, so any table created by an OLDER version of the constructor keeps its OLDER shape forever, even after the source code (and therefore the `CREATE TABLE` statement) changes.

### Fix

Pair any new column added to an EXISTING table with an idempotent `ALTER TABLE ... ADD COLUMN`, tolerating both possible states: a brand-new table already has the column (from the `CREATE TABLE` statement itself), so the `ALTER TABLE` fails with `"duplicate column name"` — expected, swallow it. An existing table predating the column genuinely lacks it, so the same statement adds it for real.

```ts
static #addColumnIfMissing(ctx: DurableObjectState, table: string, column: string, sqlType: string): void {
  try {
    ctx.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${sqlType}`)
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("duplicate column name")) {
      throw error
    }
  }
}
```

Call it right after the `CREATE TABLE IF NOT EXISTS` for that table, once per new column, in the constructor.

### Why this matters

`CREATE TABLE IF NOT EXISTS` reads as "this makes sure the table has this shape" — it doesn't; it only makes sure the table EXISTS, in whatever shape it already had. Every future column added to an existing DO SQLite table needs this same treatment, not just this one. The bug was caught live, before merge, by actually re-running an already-exercised feature after adding a column to it — a fresh `wrangler dev`/deploy with no prior state would never have hit this, since the table would be created fresh with the new column already present. Worth remembering when a fix "works" on a clean environment: a DO's persistent storage means "clean" and "already has real state from before" are genuinely different test conditions.
