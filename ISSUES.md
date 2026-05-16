# Known issues

## `Cloudflare.Secret.bind()` from SecretsStore crashes Worker boot

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
