import { Message } from "@effect-flue/shared"
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect, Schema, Stream } from "effect"

const HistorySchema = Schema.Array(Message)

type PlainMessage = { role: "user" | "assistant"; content: string }

/**
 * Storage-only Durable Object.
 *
 * Holds the persistent message history for one agent session. Has zero
 * knowledge of LLM providers, prompts, or model routing — those live in the
 * HTTP handler and the OpenRouter adapter. The DO RPC boundary requires
 * `structuredClone`-able values, so every method accepts and returns plain
 * `{role, content}` objects (no `Schema.Class` instances). See ISSUES.md.
 */
export default class Agent extends Cloudflare.DurableObjectNamespace<Agent>()(
  "Agents",
  Effect.gen(function* () {
    // @effect-diagnostics-next-line returnEffectInGen:off
    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState

      const decodeHistory = Schema.decodeUnknownEffect(HistorySchema)
      const encodeHistory = Schema.encodeEffect(HistorySchema)

      const loadHistoryRaw = state.storage.get<unknown>("history").pipe(
        Effect.flatMap((raw) =>
          raw === undefined
            ? Effect.succeed<ReadonlyArray<Message>>([])
            : decodeHistory(raw),
        ),
        Effect.orDie,
      )

      const toPlain = (
        msgs: ReadonlyArray<Message>,
      ): ReadonlyArray<PlainMessage> =>
        msgs.map((m) => ({ role: m.role, content: m.content }))

      return {
        history: () => loadHistoryRaw.pipe(Effect.map(toPlain)),

        append: (msgs: ReadonlyArray<PlainMessage>) =>
          Effect.gen(function* () {
            const existing = yield* loadHistoryRaw
            const updated: ReadonlyArray<Message> = [
              ...existing,
              ...msgs.map((m) => new Message({ role: m.role, content: m.content })),
            ]
            const encoded = yield* encodeHistory(updated).pipe(Effect.orDie)
            yield* state.storage.put("history", encoded)
            return updated.length
          }),

        reset: () => state.storage.delete("history").pipe(Effect.asVoid),

        streamPrompt: () => Stream.die("streaming not implemented yet"),
      }
    })
  }),
) {}
