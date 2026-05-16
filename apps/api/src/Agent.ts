import { Message } from "@effect-flue/shared"
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect, Schema } from "effect"
import { Sandbox } from "./Sandbox.ts"

const HistorySchema = Schema.Array(Message)

type PlainMessage = { role: "user" | "assistant"; content: string }

/**
 * Storage + sandbox Durable Object.
 *
 * Holds the persistent message history for one agent session and binds the
 * sandbox Container that backs the `Bash` tool. The DO RPC boundary requires
 * `structuredClone`-able values, so every method accepts and returns plain
 * objects (no `Schema.Class` instances). See ISSUES.md.
 */
export default class Agent extends Cloudflare.DurableObjectNamespace<Agent>()(
  "Agents",
  Effect.gen(function* () {
    // OUTER init — only the `Sandbox` class is referenced. The `.make()`
    // runtime lives in `Sandbox.runtime.ts` and is tree-shaken out of
    // this DO's bundle.
    const sandbox = yield* Cloudflare.Container.bind(Sandbox)

    // @effect-diagnostics-next-line returnEffectInGen:off
    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState

      // INNER per-instance — start the container and grab a typed handle.
      // `Cloudflare.start` calls `ensureRunning` lazily; the container
      // boots on first `exec`.
      const container = yield* Cloudflare.start(sandbox)

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
              ...msgs.map(
                (m) => new Message({ role: m.role, content: m.content }),
              ),
            ]
            const encoded = yield* encodeHistory(updated).pipe(Effect.orDie)
            yield* state.storage.put("history", encoded)
            return updated.length
          }),

        reset: () => state.storage.delete("history").pipe(Effect.asVoid),

        // `container.exec` already returns a plain `{exitCode, stdout,
        // stderr}` object because the runtime catches PlatformError into
        // an inline error result (see Sandbox.runtime.ts). No class
        // instances cross the RPC fence.
        exec: (command: string) => container.exec(command),
      }
    })
  }),
) {}
