import {
  AgentError,
  JournalApprovalRequested,
  JournalErrorEvent,
  type RulesMap,
} from "@effect-flue/shared"
import * as OpenRouterLanguageModel from "@effect/ai-openrouter/OpenRouterLanguageModel"
import { Cause, Effect, Layer } from "effect"
import { LanguageModel, Prompt, Response as AiResponse } from "effect/unstable/ai"
import { MAX_TOOL_HOPS, makeBashRunnerLayer, shouldContinueToolLoop } from "./AgentLoop.ts"
import type { AgentNamespace } from "./AgentStub.ts"
import { eventJson, journalHopBatch } from "./JournalWrite.ts"
import type { KnowledgeSearch } from "./Knowledge.ts"
import type { SessionToolkit } from "./SessionToolkit.ts"
import type { SkillsBucket } from "./Skills.ts"
import { ApprovalRules } from "./Tools.ts"

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
  /** Resolved per-tool permission rules for this turn; provided into the model call as the ApprovalRules Reference. */
  rules: RulesMap
  /** The session's merged toolkit (local tools + resolved MCP tools) handed to `generateText`. */
  toolkit: SessionToolkit["toolkit"]
  /** The matching handler layer for `toolkit`, provided into each hop's model call. */
  toolLayer: SessionToolkit["toolLayer"]
}

/**
 * The non-streaming turn driver: runs the hop-capped `generateText` loop, journaling one batch
 * per hop and returning the folded result. `done` is journaled only on a terminal finish. A hop
 * returning a `tool-approval-request` PARKS the turn (journals the request, writes the hop batch
 * with no `done`, surfaces the eventId as `approval`) rather than spinning to the hop cap.
 */
export const runPromptTurn = (
  input: RunPromptTurnInput,
): Effect.Effect<PromptTurnResult, AgentError, LanguageModel.LanguageModel | SkillsBucket | KnowledgeSearch> => {
  const { agent, initialPrompt, model, payloadModel, rules, toolkit, toolLayer, turn } = input

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
      const call = LanguageModel.generateText({ prompt: promptValue, toolkit })
      const withModel =
        payloadModel !== undefined
          ? OpenRouterLanguageModel.withConfigOverride(call, { model: payloadModel })
          : call

      const response = yield* withModel.pipe(
        Effect.provide(toolLayer),
        Effect.provide(bashRunner),
        Effect.provide(Layer.succeed(ApprovalRules, rules)),
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
