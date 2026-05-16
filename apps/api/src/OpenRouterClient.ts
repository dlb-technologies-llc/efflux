import { StreamPartDone, StreamPartTextDelta } from "@effect-flue/shared"
import type { StreamPart } from "@effect-flue/shared"
import { Effect, Filter, Result, Schema, Stream } from "effect"
import { Sse } from "effect/unstable/encoding"

export const DEFAULT_MODEL = "anthropic/claude-sonnet-4-6"

const OpenRouterChatCompletion = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      message: Schema.Struct({ content: Schema.String }),
      finish_reason: Schema.String,
    }),
  ),
  model: Schema.String,
})

const decodeChatCompletion = Schema.decodeUnknownSync(OpenRouterChatCompletion)

export const callOpenRouter = (
  apiKey: string,
  model: string,
  messages: ReadonlyArray<{ role: string; content: string }>,
) =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model, messages }),
      })
      const body = await res.text()
      if (!res.ok) {
        throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 500)}`)
      }
      const json = decodeChatCompletion(JSON.parse(body))
      const choice = json.choices[0]
      if (!choice) {
        throw new Error(`OpenRouter returned no choices: ${body.slice(0, 500)}`)
      }
      return {
        text: choice.message.content,
        finishReason: choice.finish_reason,
        model: json.model,
      }
    },
    catch: (cause) =>
      cause instanceof Error
        ? cause
        : new Error(`OpenRouter call failed: ${String(cause)}`),
  })

// Permissive schema for streamed chunks — OpenRouter may add fields.
// `choices` is `[]` on the trailing usage-only chunk when
// `stream_options.include_usage` is enabled.
const OpenRouterStreamChunk = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      delta: Schema.Struct({
        content: Schema.optional(Schema.NullOr(Schema.String)),
      }),
      finish_reason: Schema.NullOr(Schema.String),
    }),
  ),
})

const decodeStreamChunk = Schema.decodeUnknownEffect(OpenRouterStreamChunk)

const toStreamPart = Filter.make(
  (chunk: typeof OpenRouterStreamChunk.Type): Result.Result<StreamPart, void> => {
    const choice = chunk.choices[0]
    if (!choice) return Result.fail(undefined)
    const content = choice.delta.content
    if (typeof content === "string" && content.length > 0) {
      return Result.succeed(new StreamPartTextDelta({ delta: content }))
    }
    if (typeof choice.finish_reason === "string") {
      return Result.succeed(
        new StreamPartDone({
          finishReason: choice.finish_reason,
          toolCallCount: 0,
        }),
      )
    }
    return Result.fail(undefined)
  },
)

export const streamOpenRouter = (args: {
  apiKey: string
  model: string
  messages: ReadonlyArray<{ role: string; content: string }>
  signal?: AbortSignal
}): Stream.Stream<StreamPart, Error> => {
  const open = Effect.tryPromise({
    try: async () => {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${args.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: args.model,
          messages: args.messages,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: args.signal,
      })
      if (!res.ok) {
        const body = await res.text()
        throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 500)}`)
      }
      if (!res.body) {
        throw new Error("OpenRouter returned no body for streaming request")
      }
      return res.body
    },
    catch: (cause) =>
      cause instanceof Error
        ? cause
        : new Error(`OpenRouter stream call failed: ${String(cause)}`),
  })

  return Stream.unwrap(
    Effect.map(open, (body) =>
      Stream.fromReadableStream({
        evaluate: () => body,
        onError: (cause) => new Error(String(cause)),
      }).pipe(
        Stream.decodeText(),
        Stream.pipeThroughChannel(Sse.decode<Error, unknown>()),
        Stream.catchTags({
          Retry: (retry) =>
            Stream.fail(
              new Error(
                `OpenRouter requested SSE retry after ${String(retry.duration)}`,
              ),
            ),
        }),
        Stream.takeWhile((event) => event.data !== "[DONE]"),
        Stream.mapEffect((event) =>
          Effect.flatMap(
            Effect.try({
              try: (): unknown => JSON.parse(event.data),
              catch: (cause) =>
                new Error(`Failed to parse SSE chunk JSON: ${String(cause)}`),
            }),
            (json) =>
              Effect.mapError(
                decodeStreamChunk(json),
                (cause) =>
                  new Error(
                    `Failed to decode OpenRouter stream chunk: ${String(cause)}`,
                  ),
              ),
          ),
        ),
        Stream.filterMap(toStreamPart),
        // Some OpenRouter-hosted models (notably Anthropic) emit
        // `finish_reason` on more than one chunk, which would otherwise
        // produce duplicate `done` frames. Stop at the first one.
        Stream.takeUntil((part) => part._tag === "done"),
      ),
    ),
  )
}
