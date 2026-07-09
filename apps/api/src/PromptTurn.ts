import {
  AgentError,
  JournalApprovalRequested,
  JournalAssistantText,
  JournalDone,
  JournalErrorEvent,
} from "@effect-flue/shared"
import * as OpenRouterLanguageModel from "@effect/ai-openrouter/OpenRouterLanguageModel"
import { Cause, Effect } from "effect"
import { LanguageModel, Prompt, Response as AiResponse } from "effect/unstable/ai"
import { MAX_TOOL_HOPS, makeBashRunnerLayer, shouldContinueToolLoop } from "./AgentLoop.ts"
import type { AgentNamespace } from "./AgentStub.ts"
import { buildHopEvents, buildUsageEvent, eventJson } from "./JournalWrite.ts"
import type { SkillsBucket } from "./Skills.ts"
import { AgentToolkit, AgentToolkitLayer } from "./Tools.ts"

/** Where a parked turn resumes: the eventId to POST to `/approve/:eventId`. */
export interface PromptApproval {
  eventId: number
  approvalId: string
  toolCallId: string
}

export interface PromptTurnResult {
  finalText: string
  finalFinishReason: AiResponse.FinishReason
  toolCallCount: number
  /** True when any hop produced text — matches the DO's history fold. */
  anyHopText: boolean
  /** Present when the turn parked awaiting a tool approval (#40). */
  approval: PromptApproval | undefined
}

interface RunPromptTurnInput {
  agent: ReturnType<AgentNamespace["getByName"]>
  turn: number
  initialPrompt: Prompt.Prompt
  model: string
  payloadModel: string | undefined
}

/**
 * The non-streaming turn driver: runs the hop-capped `generateText` loop, journaling one batch
 * per hop and returning the folded result. `done` is journaled only on a terminal finish. A hop
 * returning a `tool-approval-request` PARKS the turn (journals the request, writes the hop batch
 * with no `done`, surfaces the eventId as `approval`) rather than spinning to the hop cap.
 */
export const runPromptTurn = (
  input: RunPromptTurnInput,
): Effect.Effect<PromptTurnResult, AgentError, LanguageModel.LanguageModel | SkillsBucket> => {
  const { agent, initialPrompt, model, payloadModel, turn } = input

  const bashRunner = makeBashRunnerLayer((command) => agent.exec(command))

  const snapshotWorkspace = Effect.promise(() => agent.snapshotIfDirty()).pipe(
    Effect.catchCause((cause) => Effect.logError("Workspace snapshot failed", cause)),
    Effect.asVoid,
  )

  const loop = Effect.gen(function* () {
    let promptValue: Prompt.Prompt = initialPrompt
    let finalText = ""
    let finalFinishReason: AiResponse.FinishReason = "unknown"
    let toolCallCount = 0
    let anyHopText = false
    let approval: PromptApproval | undefined

    for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
      const call = LanguageModel.generateText({ prompt: promptValue, toolkit: AgentToolkit })
      const withModel =
        payloadModel !== undefined
          ? OpenRouterLanguageModel.withConfigOverride(call, { model: payloadModel })
          : call

      const response = yield* withModel.pipe(
        Effect.provide(AgentToolkitLayer),
        Effect.provide(bashRunner),
        Effect.catch((cause) =>
          Effect.fail(
            new AgentError({
              message:
                cause instanceof Error
                  ? cause.message
                  : `LanguageModel.generateText failed: ${String(cause)}`,
            }),
          ),
        ),
      )

      toolCallCount += response.toolCalls.length
      finalText = response.text
      finalFinishReason = response.finishReason
      anyHopText ||= response.text.length > 0

      const approvalPart = response.content.find((p) => p.type === "tool-approval-request")
      if (approvalPart !== undefined && approvalPart.type === "tool-approval-request") {
        const approvalSeqs = yield* Effect.promise(() =>
          agent.appendEvents([
            eventJson(
              new JournalApprovalRequested({
                turn,
                hop,
                approvalId: approvalPart.approvalId,
                toolCallId: approvalPart.toolCallId,
              }),
            ),
          ]),
        )
        yield* journalHopBatch({ agent, turn, hop, model, parts: response.content, text: response.text })
        const approvalSeq = approvalSeqs[0]
        if (approvalSeq !== undefined) {
          approval = {
            eventId: approvalSeq,
            approvalId: approvalPart.approvalId,
            toolCallId: approvalPart.toolCallId,
          }
        }
        break
      }

      const terminal = !shouldContinueToolLoop(response.finishReason)
      yield* journalHopBatch({
        agent,
        turn,
        hop,
        model,
        parts: response.content,
        text: response.text,
        ...(terminal ? { done: { finishReason: response.finishReason, toolCallCount } } : {}),
      })

      if (terminal) break
      promptValue = Prompt.concat(promptValue, Prompt.fromResponseParts(response.content))
    }

    return { finalText, finalFinishReason, toolCallCount, anyHopText, approval }
  })

  return loop.pipe(
    Effect.ensuring(snapshotWorkspace),
    Effect.tapCause((cause) =>
      Effect.promise(() =>
        agent.appendEvents([eventJson(new JournalErrorEvent({ turn, message: Cause.pretty(cause) }))]),
      ).pipe(Effect.catchCause(() => Effect.void)),
    ),
  )
}

/**
 * One batched hop-end journal write: granular tool events + authoritative
 * hop-messages + display text + usage, and `done` only when `done` is supplied
 * (a terminal, non-parked finish).
 */
const journalHopBatch = (input: {
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
