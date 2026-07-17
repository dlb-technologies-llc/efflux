import {
  type AgentError,
  type ApprovalHandle,
  JournalApprovalRequested,
  type RulesMap,
} from "@efflux/shared"
import * as OpenRouterLanguageModel from "@effect/ai-openrouter/OpenRouterLanguageModel"
import { Clock, Effect } from "effect"
import { LanguageModel, Prompt, type Response as AiResponse } from "effect/unstable/ai"
import {
  MAX_TOOL_HOPS,
  MODEL_HOP_TIMEOUT,
  journalTurnError,
  makeTurnLayers,
  shouldContinueToolLoop,
  snapshotWorkspace,
  toAgentError,
} from "./AgentLoop.ts"
import type { AgentNamespace } from "./AgentStub.ts"
import { type SpendCaps, type SpendTotals, addSpend, budgetExceeded } from "./Budget.ts"
import { eventJson, hopCostUsd, journalHopBatch } from "./JournalWrite.ts"
import type { KnowledgeSearch } from "./Knowledge.ts"
import { logTurnMetric } from "./Metrics.ts"
import type { SessionToolkit } from "./SessionToolkit.ts"
import type { SkillsBucket } from "./Skills.ts"

/** Where a parked turn resumes: the eventId to POST to `/approve/:eventId`. Derived from the shared `ApprovalHandle` schema so the coordinates never drift from the contract. */
export type PromptApproval = typeof ApprovalHandle.Type

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
  /** Session key (`name/id`) stamped on the per-turn `[metric]` line. */
  sessionId: string
  /** Resolved per-tool permission rules for this turn; provided into the model call as the ApprovalRules Reference. */
  rules: RulesMap
  /** The session's merged toolkit (local tools + resolved MCP tools) handed to `generateText`. */
  toolkit: SessionToolkit["toolkit"]
  /** The matching handler layer for `toolkit`, provided into each hop's model call. */
  toolLayer: SessionToolkit["toolLayer"]
  /** Resolved spend ceilings for this session; the loop stops before a hop that would run over. */
  readonly caps: SpendCaps
  /** Cumulative spend BEFORE this turn (summed from the journal); the running total seeds from it. */
  readonly priorSpend: SpendTotals
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
  const { agent, caps, initialPrompt, model, priorSpend, rules, sessionId, toolkit, toolLayer, turn } = input

  const turnLayers = makeTurnLayers(agent, turn, rules, toolLayer)

  let startMs = 0
  let toolCallCount = 0
  let costTotal = 0
  let parked = false

  const loop = Effect.gen(function* () {
    startMs = yield* Clock.currentTimeMillis
    let promptValue: Prompt.Prompt = initialPrompt
    let finalText = ""
    let finalFinishReason: AiResponse.FinishReason = "unknown"
    let anyHopText = false
    let approval: PromptApproval | undefined
    let running: SpendTotals = priorSpend

    for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
      if (budgetExceeded(running, caps)) break
      const call = LanguageModel.generateText({ prompt: promptValue, toolkit })
      const withModel = OpenRouterLanguageModel.withConfigOverride(call, { model })

      const response = yield* withModel.pipe(
        Effect.provide(turnLayers),
        Effect.timeout(MODEL_HOP_TIMEOUT),
        Effect.catch(toAgentError("LanguageModel.generateText")),
      )

      toolCallCount += response.toolCalls.length
      costTotal += hopCostUsd(response.content) ?? 0
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
        parked = true
        break
      }

      const terminal = !shouldContinueToolLoop(response.finishReason)
      const delta = yield* journalHopBatch({
        agent,
        turn,
        hop,
        model,
        parts: response.content,
        text: response.text,
        ...(terminal ? { done: { finishReason: response.finishReason, toolCallCount } } : {}),
      })
      running = addSpend(running, delta)

      if (terminal) break
      promptValue = Prompt.concat(promptValue, Prompt.fromResponseParts(response.content))
    }

    return { finalText, finalFinishReason, toolCallCount, anyHopText, approval }
  })

  return loop.pipe(
    Effect.ensuring(
      Effect.suspend(() =>
        parked || startMs === 0
          ? Effect.void
          : Clock.currentTimeMillis.pipe(
              Effect.flatMap((now) =>
                logTurnMetric({ sessionId, model, latencyMs: now - startMs, costUsd: costTotal, toolCalls: toolCallCount }),
              ),
            ),
      ),
    ),
    Effect.ensuring(snapshotWorkspace(agent)),
    Effect.tapCause(journalTurnError(agent, turn)),
  )
}
