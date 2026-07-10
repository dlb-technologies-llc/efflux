/**
 * Context compaction: a pure turn-folding planner, a toolkit-free summarizer
 * (the `Subagent.ts` single-shot pattern), and a best-effort orchestrator that
 * appends an additive `compaction` event when the latest usage crosses a
 * threshold. Compaction is additive — it NEVER rewrites or deletes journal
 * rows; the history fold serves `summary + turns after throughSeq`.
 */
import * as OpenRouterLanguageModel from "@effect/ai-openrouter/OpenRouterLanguageModel"
import { type AgentError, JournalCompaction } from "@effect-flue/shared"
import { Effect } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import { MODEL_HOP_TIMEOUT, toAgentError } from "./AgentLoop.ts"
import type { AgentNamespace } from "./AgentStub.ts"
import { fetchAllEvents } from "./JournalRead.ts"
import { capForPrompt } from "./Truncate.ts"
import { eventJson } from "./JournalWrite.ts"
import type { ReconstructEvent } from "./Reconstruct.ts"

/** Verbatim turns kept at the tail; everything older (beyond the prior watermark) is summarized. */
export const KEEP_RECENT_TURNS = 2

interface CompactionPlan {
  readonly throughSeq: number
  readonly priorSummary: string | undefined
  readonly olderMessages: ReadonlyArray<{ role: "user" | "assistant"; content: string }>
}

interface FoldedTurn {
  readonly userSeq: number
  readonly userContent: string | undefined
  readonly texts: Array<string>
}

/** Pure planner: fold events into turns, keep the last KEEP_RECENT_TURNS beyond the prior watermark verbatim, return the slice to summarize with the prior summary to chain; undefined when nothing new to compact. */
export const planCompaction = (
  events: ReadonlyArray<ReconstructEvent>,
): CompactionPlan | undefined => {
  const sorted = [...events].sort((a, b) => a.seq - b.seq)

  const turns = new Map<number, FoldedTurn>()
  const order: Array<number> = []
  let priorThrough = -1
  let priorSummary: string | undefined

  for (const { event, seq } of sorted) {
    switch (event._tag) {
      case "user-message": {
        turns.set(seq, { userSeq: seq, userContent: event.content, texts: [] })
        order.push(seq)
        break
      }
      case "assistant-text": {
        const existing = turns.get(event.turn)
        if (existing !== undefined) {
          existing.texts.push(event.text)
        } else {
          turns.set(event.turn, {
            userSeq: event.turn,
            userContent: undefined,
            texts: [event.text],
          })
          order.push(event.turn)
        }
        break
      }
      case "compaction": {
        priorThrough = event.throughSeq
        priorSummary = event.summary
        break
      }
      default:
        break
    }
  }

  const eligible: Array<{
    userSeq: number
    messages: Array<{ role: "user" | "assistant"; content: string }>
  }> = []
  for (const key of order) {
    const turn = turns.get(key)
    if (turn === undefined || turn.userSeq <= priorThrough) continue
    const messages: Array<{ role: "user" | "assistant"; content: string }> = []
    if (turn.userContent !== undefined) {
      messages.push({ role: "user", content: turn.userContent })
    }
    const text = turn.texts.join("")
    if (text.length > 0) {
      messages.push({ role: "assistant", content: text })
    }
    eligible.push({ userSeq: turn.userSeq, messages })
  }

  if (eligible.length <= KEEP_RECENT_TURNS) return undefined

  const toSummarize = eligible.slice(0, eligible.length - KEEP_RECENT_TURNS)
  const last = toSummarize[toSummarize.length - 1]
  if (last === undefined) return undefined
  const olderMessages = toSummarize.flatMap((t) => t.messages)
  return { throughSeq: last.userSeq, priorSummary, olderMessages }
}

/** One toolkit-free summarization call (the Subagent.ts pattern): prior summary + older turns → a dense cumulative summary. */
export const buildCompactionSummary = (input: {
  priorSummary: string | undefined
  olderMessages: ReadonlyArray<{ role: "user" | "assistant"; content: string }>
  model: string
}): Effect.Effect<string, AgentError, LanguageModel.LanguageModel> =>
  Effect.gen(function* () {
    const SYS =
      "You are compacting a long conversation. Produce a dense summary preserving user goals, decisions, established facts, and open threads. Do NOT restate the todo list — it is tracked separately. Output only the summary."
    const USER =
      (input.priorSummary !== undefined
        ? `Earlier summary:\n${input.priorSummary}\n\n`
        : "") +
      input.olderMessages.map((m) => `${m.role}: ${m.content}`).join("\n\n")
    const messages: Array<{ role: "system" | "user"; content: string }> = [
      { role: "system", content: SYS },
      { role: "user", content: USER },
    ]
    const call = LanguageModel.generateText({ prompt: messages })
    const withModel = OpenRouterLanguageModel.withConfigOverride(call, {
      model: input.model,
    })
    const response = yield* withModel.pipe(
      Effect.timeout(MODEL_HOP_TIMEOUT),
      Effect.catch(toAgentError("buildCompactionSummary")),
    )
    return response.text
  })

/** Best-effort: if the latest usage exceeds `threshold`, summarize older turns and append a `compaction` event. NEVER fails a turn (swallows its cause, like snapshotWorkspace). */
export const compactIfNeeded = (
  agent: ReturnType<AgentNamespace["getByName"]>,
  model: string,
  threshold: number,
): Effect.Effect<void, never, LanguageModel.LanguageModel> =>
  Effect.gen(function* () {
    const tokens = yield* Effect.promise(() => agent.latestUsageTokens())
    if (tokens === null || tokens < threshold) return
    const events = yield* fetchAllEvents(agent)
    const plan = planCompaction(events)
    if (plan === undefined) return
    const summary = yield* buildCompactionSummary({
      priorSummary: plan.priorSummary,
      olderMessages: plan.olderMessages,
      model,
    })
    yield* Effect.promise(() =>
      agent.appendEvents([
        eventJson(new JournalCompaction({ throughSeq: plan.throughSeq, summary: capForPrompt(summary) })),
      ]),
    )
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("compaction skipped", cause)),
    Effect.asVoid,
  )
