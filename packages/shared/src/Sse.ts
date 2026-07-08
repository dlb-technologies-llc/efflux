import { Effect, Schema, Stream } from "effect"
import * as Sse from "effect/unstable/encoding/Sse"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"

/**
 * Consume an agent Server-Sent-Events response as a typed `Stream`.
 *
 * Symmetric with the server, which ENCODES its frames with this same
 * `effect/unstable/encoding/Sse` module (`Sse.encoder` in the streaming
 * handler): response bytes → text → `Sse.decodeDataSchema(schema)`, which
 * JSON-decodes each event's `data` field through `schema` and preserves the
 * SSE `event`/`id`. Decode failures land in the `Stream` error channel — never
 * thrown, and there is no hand-rolled framing/`JSON.parse` loop.
 *
 * This replaces the byte-identical hand-written `parseSseEvent`/`sseEvents`
 * parsers that were previously duplicated in `apps/web` and `apps/tui` (each
 * living outside Effect and silently dropping the SSE `id`).
 *
 * Takes the request `Effect` (e.g. `HttpClient.post(url, { body })`) and yields
 * the decoded `data` values. The SSE `id` — the journal `seq` the server stamps
 * for `Last-Event-ID` re-attach (#49) — is carried on the `decodeDataSchema`
 * output; surface it from here if/when re-attach needs it.
 */
export const streamAgentSse = <A, RD, E, R>(
  request: Effect.Effect<HttpClientResponse.HttpClientResponse, E, R>,
  schema: Schema.ConstraintDecoder<A, RD>,
) =>
  HttpClientResponse.stream(request).pipe(
    Stream.decodeText(),
    Stream.pipeThroughChannel(Sse.decodeDataSchema(schema)),
    Stream.map((event) => event.data),
  )
