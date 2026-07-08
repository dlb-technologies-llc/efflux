import { makePromptRequest, PromptRequest, StreamPart, streamAgentSse } from "@effect-flue/shared"
import { Effect, Schema, Stream } from "effect"
import { HttpBody, HttpClient } from "effect/unstable/http"
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
 * Query atom (per-session): load persisted history. `Atom.family` memoises via
 * `MutableHashMap` (structural `Equal`/`Hash`), so each unique `{name, id}`
 * returns the same underlying atom and the fetch fires on first subscribe.
 */
export const historyAtom = Atom.family((args: SessionArgs) =>
  runtime.atom(
    Effect.fnUntraced(function*() {
      const client = yield* ApiClient
      return yield* client.agents.history({ params: { name: args.name, id: args.id } })
    })(),
  ),
)

/** Empty typed seed for the streaming accumulator (avoids an `as` cast). */
const noParts: ReadonlyArray<StreamPart> = []

/**
 * Stream atom: POST the prompt to `/agents/:name/:id/stream` and emit the
 * accumulated `StreamPart[]` after each event.
 *
 * The transport is fully Effect: `HttpClient` + the shared `streamAgentSse`
 * (built on `effect/unstable/encoding/Sse`, symmetric with the server's
 * `Sse.encoder`) — no raw `fetch`, no hand-rolled parser, decode failures in
 * the Stream error channel. `Stream.scan` makes the atom own accumulation, so
 * each published value is the whole transcript-so-far: the consumer just reads
 * the latest array (no manual token concatenation), and multi-event SSE chunks
 * can never drop a token the way a last-element-per-chunk value atom would.
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
    Stream.unwrap(
      Effect.gen(function*() {
        const client = yield* HttpClient.HttpClient
        const url = `/agents/${encodeURIComponent(args.name)}/${encodeURIComponent(args.id)}/stream`
        const body = HttpBody.text(
          JSON.stringify(encodePromptRequest(makePromptRequest(args.message, args))),
          "application/json",
        )
        return streamAgentSse(client.post(url, { body }), StreamPart).pipe(
          Stream.scan(noParts, (parts, part) => [...parts, part]),
        )
      }),
    ),
)
