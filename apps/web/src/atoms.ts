import { PromptRequest, StreamPart } from "@effect-flue/shared"
import { Effect as Effect } from "effect"
import { Schema as Schema } from "effect"
import { Stream as Stream } from "effect"
import { Atom } from "effect/unstable/reactivity"
import { ApiClient, runtime } from "./runtime.ts"

const encodePromptRequest = Schema.encodeSync(PromptRequest)

/**
 * Arguments shared by every per-session atom.
 *
 * `name` + `id` form the Durable-Object-backed session key on the Worker.
 */
export interface SessionArgs {
  readonly name: string
  readonly id: string
}

/**
 * Mutation atom: send a single prompt and receive the final assistant
 * response (non-streaming). Thin wrapper - error handling lives in the
 * consumer component.
 */
export const promptAtom = runtime.fn(
  Effect.fnUntraced(function*(
    args: SessionArgs & {
      readonly message: string
      readonly model?: string
      readonly skill?: string
      readonly role?: string
    },
  ) {
    const client = yield* ApiClient
    // HttpApiClient encodes the payload via PromptRequest schema, which is
    // a Schema.Class — it requires an actual class instance, not a plain
    // object with the matching shape. Same constraint as the server's
    // response encoder. See ISSUES.md.
    return yield* client.agents.prompt({
      params: { name: args.name, id: args.id },
      payload: new PromptRequest({
        message: args.message,
        ...(args.model !== undefined ? { model: args.model } : {}),
        ...(args.skill !== undefined ? { skill: args.skill } : {}),
        ...(args.role !== undefined ? { role: args.role } : {}),
      }),
    })
  }),
)

/**
 * Mutation atom: clear server-side session history.
 */
export const resetAtom = runtime.fn(
  Effect.fnUntraced(function*(args: SessionArgs) {
    const client = yield* ApiClient
    yield* client.agents.reset({ params: { name: args.name, id: args.id } })
  }),
)

/**
 * Schema-derived decoder for the family key (a JSON-encoded `{name, id}`).
 * Re-using a real schema keeps us off `as` casts when reading the parsed key.
 */
const SessionArgsSchema = Schema.Struct({
  name: Schema.String,
  id: Schema.String,
})
const decodeSessionArgs = Schema.decodeUnknownSync(SessionArgsSchema)

/**
 * Query atom (per-session): load persisted history. Uses `Atom.family` so each
 * unique `{name, id}` key memoises to the same underlying atom and the fetch
 * fires automatically on first subscribe - no setter call needed.
 *
 * Family key is `JSON.stringify({name, id})`; `Atom.family` memoises by
 * identity, so object literals would never match across renders.
 */
export const historyAtom = Atom.family((key: string) =>
  runtime.atom(
    Effect.fnUntraced(function*() {
      const args = decodeSessionArgs(JSON.parse(key))
      const client = yield* ApiClient
      return yield* client.agents.history({ params: { name: args.name, id: args.id } })
    })(),
  ),
)

/**
 * Stable string key for `historyAtom`.
 */
export const historyKey = (args: SessionArgs): string => JSON.stringify({ name: args.name, id: args.id })

/**
 * Decode a single SSE `data: <json>` event into a `StreamPart`. Decode
 * failures propagate as stream errors - never silently dropped.
 */
const decodeStreamPart = Schema.decodeUnknownEffect(StreamPart)

const parseSseEvent = (raw: string): unknown => {
  // SSE event blocks may contain multiple lines; only the `data:` lines carry payload.
  const dataLines: Array<string> = []
  for (const line of raw.split("\n")) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^\s/, ""))
    }
  }
  return JSON.parse(dataLines.join("\n"))
}

/**
 * Yields parsed `unknown` JSON payloads from an SSE response body. Each yield
 * corresponds to one `\n\n`-delimited SSE event. Decoding into `StreamPart`
 * happens downstream via `Schema.decodeUnknownEffect`.
 */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        const trimmed = buffer.trim()
        if (trimmed.length > 0) {
          yield parseSseEvent(trimmed)
        }
        return
      }
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf("\n\n")
      while (boundary !== -1) {
        const event = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const trimmed = event.trim()
        if (trimmed.length > 0) {
          yield parseSseEvent(trimmed)
        }
        boundary = buffer.indexOf("\n\n")
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Stream atom: opens an SSE connection to `/agents/:name/:id/stream` and
 * emits each decoded `StreamPart`. The atom result reflects the latest
 * delta; for token-by-token consumption, subscribe with `useAtomSubscribe`
 * (per-emit callback). `useAtomValue` only re-reads on React's commit
 * cycle and can coalesce multiple emits in one tick.
 *
 * Errors from `fetch`, JSON parsing, or schema validation surface as
 * stream failures - no silent drops.
 *
 * ⚠️ LOAD-BEARING INVARIANT — chunk size MUST be 1.
 *
 * `Atom.fn` over a Stream calls `setSelf(AsyncResult.success(Arr.lastNonEmpty(chunk)))`,
 * which only publishes the LAST element of each pulled chunk. If any operator
 * in this pipe ever batches multiple values into one chunk (e.g.
 * `Stream.grouped`, `Stream.bufferChunks`, `Stream.debounce`, `Stream.aggregate`),
 * the intermediate tokens will be silently dropped — the UI will see the
 * final token of each batch and nothing else.
 *
 * The current pipe is safe because `Stream.fromAsyncIterable` wraps each
 * yield in `Arr.of(value)` (a 1-element chunk) and `Stream.mapEffect`
 * preserves chunk structure 1:1. Adding any batching/aggregation operator
 * here will silently break token-by-token rendering. If you need batching
 * for some unrelated reason, switch this atom to `runtime.pull` (which
 * accumulates pulled items) and update the FE consumer to read the
 * accumulated list instead of a single value.
 */
export const streamAtom = runtime.fn(
  (
    args: SessionArgs & {
      readonly message: string
      readonly model?: string
      readonly skill?: string
      readonly role?: string
    },
  ) =>
    Stream.fromAsyncIterable(
      (async function*() {
        const body = encodePromptRequest(
          new PromptRequest({
            message: args.message,
            ...(args.model !== undefined ? { model: args.model } : {}),
            ...(args.skill !== undefined ? { skill: args.skill } : {}),
            ...(args.role !== undefined ? { role: args.role } : {}),
          }),
        )
        const response = await fetch(`/agents/${encodeURIComponent(args.name)}/${encodeURIComponent(args.id)}/stream`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
        if (!response.ok || response.body === null) {
          throw new Error(`Stream request failed: ${response.status} ${response.statusText}`)
        }
        for await (const event of sseEvents(response.body)) {
          yield event
        }
      })(),
      (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    ).pipe(Stream.mapEffect((event) => decodeStreamPart(event))),
)
