import {
  AgentError,
  JournalAssistantText,
  JournalDone,
  JournalEventPayload,
  JournalHopMessages,
  JournalToolCall,
  JournalToolResult,
  JournalUsage,
  JournalUserMessage,
} from "@efflux/shared"
import { Effect, Result, Schema } from "effect"
import { Prompt, type Response as AiResponse } from "effect/unstable/ai"
import type { AgentNamespace } from "./AgentStub.ts"

/**
 * Journal-writing helpers shared by the streaming and non-streaming turn
 * drivers. Journal payloads cross the DO RPC fence as schema-encoded JSON text
 * (the DO validates and stores it verbatim — see ISSUES.md).
 */

export const encodeEventPayload = Schema.encodeSync(JournalEventPayload)
export const decodeEventPayload = Schema.decodeUnknownEffect(JournalEventPayload)

/** Encode a journal event to the JSON text the DO stores. */
export const eventJson = (event: JournalEventPayload): string =>
  JSON.stringify(encodeEventPayload(event))

/**
 * Build a hop's granular tool events plus its authoritative `hop-messages`
 * event from the response parts. `Prompt.fromResponseParts` is the canonical
 * response-to-prompt mapping, so extracting the granular events from its output
 * keeps the two journal layers from ever disagreeing.
 */
export const buildHopEvents = (input: {
  turn: number
  hop: number
  parts: ReadonlyArray<AiResponse.AnyPart>
}): Array<JournalEventPayload> => {
  const messages = Prompt.fromResponseParts(input.parts).content
  const events: Array<JournalEventPayload> = []
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "tool-call") {
          events.push(
            new JournalToolCall({ turn: input.turn, hop: input.hop, part }),
          )
        }
      }
    } else if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type === "tool-result") {
          events.push(
            new JournalToolResult({ turn: input.turn, hop: input.hop, part }),
          )
        }
      }
    }
  }
  if (messages.length > 0) {
    events.push(
      new JournalHopMessages({ turn: input.turn, hop: input.hop, messages }),
    )
  }
  return events
}

/**
 * OpenRouter reports `cost` (USD) inside the finish part's provider metadata
 * when the account has usage tracking; the generated type omits it, so it is
 * decoded schema-first and the other raw-usage fields are ignored.
 */
const OpenRouterCostSchema = Schema.Struct({
  cost: Schema.optionalKey(Schema.Number),
})
const decodeOpenRouterCost = Schema.decodeUnknownResult(OpenRouterCostSchema)

/**
 * Build a hop's `usage` event from its `finish` part: typed token counts plus
 * OpenRouter's cost when reported. Returns undefined when the hop had no finish
 * part.
 */
export const buildUsageEvent = (input: {
  turn: number
  hop: number
  model: string
  parts: ReadonlyArray<AiResponse.AnyPart>
}): JournalUsage | undefined => {
  const finish = input.parts.find((part) => part.type === "finish")
  if (finish === undefined) return undefined
  const inputTokens = finish.usage.inputTokens.total
  const outputTokens = finish.usage.outputTokens.total
  const rawUsage = finish.metadata.openrouter?.usage
  const costResult =
    rawUsage !== null && rawUsage !== undefined
      ? decodeOpenRouterCost(rawUsage)
      : undefined
  const cost =
    costResult !== undefined && Result.isSuccess(costResult)
      ? costResult.success.cost
      : undefined
  return new JournalUsage({
    turn: input.turn,
    hop: input.hop,
    model: input.model,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(inputTokens !== undefined && outputTokens !== undefined
      ? { totalTokens: inputTokens + outputTokens }
      : {}),
    ...(typeof cost === "number" ? { cost } : {}),
  })
}

/**
 * Open a turn by journaling its `user-message` before any model call. The
 * returned seq is the turn id stamped on every later event, so a failed or
 * disconnected turn leaves no orphan state.
 */
export const openTurn = (
  agent: ReturnType<AgentNamespace["getByName"]>,
  payload: {
    readonly message: string
    readonly skill?: string
    readonly role?: string
    readonly model?: string
  },
): Effect.Effect<number, AgentError> =>
  Effect.gen(function* () {
    const userEvent = new JournalUserMessage({
      content: payload.message,
      ...(payload.skill !== undefined ? { skill: payload.skill } : {}),
      ...(payload.role !== undefined ? { role: payload.role } : {}),
      ...(payload.model !== undefined ? { model: payload.model } : {}),
    })
    const seqs = yield* Effect.promise(() =>
      agent.appendEvents([eventJson(userEvent)]),
    )
    const turn = seqs[0]
    if (turn === undefined) {
      return yield* new AgentError({
        message: "journal append returned no seq",
      })
    }
    return turn
  })

/**
 * One batched hop-end journal write shared by every turn driver: granular tool
 * events + authoritative `hop-messages` + display text + usage, and `done` only
 * when supplied (a terminal, non-parked finish).
 */
export const journalHopBatch = (input: {
  agent: ReturnType<AgentNamespace["getByName"]>
  turn: number
  hop: number
  model: string
  parts: ReadonlyArray<AiResponse.AnyPart>
  text: string
  done?: { finishReason: AiResponse.FinishReason; toolCallCount: number }
}) =>
  Effect.gen(function* () {
    const events = buildHopEvents({ turn: input.turn, hop: input.hop, parts: input.parts })
    if (input.text.length > 0) {
      events.push(new JournalAssistantText({ turn: input.turn, hop: input.hop, text: input.text }))
    }
    const usage = buildUsageEvent({ turn: input.turn, hop: input.hop, model: input.model, parts: input.parts })
    if (usage !== undefined) events.push(usage)
    if (input.done !== undefined) {
      events.push(
        new JournalDone({
          turn: input.turn,
          finishReason: input.done.finishReason,
          toolCallCount: input.done.toolCallCount,
        }),
      )
    }
    if (events.length > 0) {
      yield* Effect.promise(() => input.agent.appendEvents(events.map(eventJson)))
    }
  })
