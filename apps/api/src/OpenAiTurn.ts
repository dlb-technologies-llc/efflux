import {
  type AgentError,
  ChatCompletionChunk,
  JournalErrorEvent,
  type RulesMap,
} from "@efflux/shared"
import * as OpenRouterLanguageModel from "@effect/ai-openrouter/OpenRouterLanguageModel"
import { Cause, type Context, Effect, Layer, Queue, Schema, Stream } from "effect"
import { LanguageModel, Prompt, type Response as AiResponse } from "effect/unstable/ai"
import type * as AiError from "effect/unstable/ai/AiError"
import { Sse } from "effect/unstable/encoding"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
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
import { eventJson, journalHopBatch } from "./JournalWrite.ts"
import type { KnowledgeSearch } from "./Knowledge.ts"
import type { SessionToolkit } from "./SessionToolkit.ts"
import type { SkillsBucket } from "./Skills.ts"

/** Fixed OpenAI object id + creation time + model label for one facade turn's frames. */
interface TurnMeta {
  readonly id: string
  readonly created: number
  readonly model: string
}

/** Accumulated result of a collected (non-stream) facade turn. */
interface CollectedTurn {
  readonly text: string
  readonly lastInputTokens: number
  readonly totalOutputTokens: number
}

/** Shared inputs for both facade turn drivers. `meta` stamps the OpenAI frames the caller builds. */
interface FacadeTurnInput {
  readonly agent: ReturnType<AgentNamespace["getByName"]>
  readonly turn: number
  readonly initialPrompt: Prompt.Prompt
  readonly model: string
  readonly rules: RulesMap
  /** The session's merged toolkit (local tools + resolved MCP tools) handed to the model call. */
  readonly toolkit: SessionToolkit["toolkit"]
  /** The matching handler layer for `toolkit`, provided into each hop's model call. */
  readonly toolLayer: SessionToolkit["toolLayer"]
  readonly meta: TurnMeta
  /** Resolved spend ceilings for this session; the loop stops before a hop that would run over. */
  readonly caps: SpendCaps
  /** Cumulative spend BEFORE this turn (summed from the journal); the running total seeds from it. */
  readonly priorSpend: SpendTotals
}

/** Streaming driver inputs: the root context is forwarded so the forked stream can reach the model + skills bucket. */
interface StreamTurnInput extends FacadeTurnInput {
  readonly ambient: Context.Context<LanguageModel.LanguageModel | SkillsBucket | KnowledgeSearch>
}

/** Message emitted when a facade turn hits an approval gate; approvals are coerced off upstream, so this only fires defensively. */
const APPROVAL_DISABLED = "facade turn requested tool approval; approvals are disabled"

/**
 * The collected (non-stream) facade driver: runs the hop-capped `generateText`
 * loop, journaling one batch per hop and folding the final text plus token
 * accounting. `done` is journaled only on a terminal finish. Facade turns never
 * park — an approval request (which coercion should prevent) is journaled as an
 * error and ends the turn.
 */
export const collectOpenAiTurn = (
  input: FacadeTurnInput,
): Effect.Effect<CollectedTurn, AgentError, LanguageModel.LanguageModel | SkillsBucket | KnowledgeSearch> => {
  const { agent, caps, initialPrompt, model, priorSpend, rules, toolkit, toolLayer, turn } = input

  const turnLayers = makeTurnLayers(agent, turn, rules, toolLayer)

  const loop = Effect.gen(function* () {
    let promptValue: Prompt.Prompt = initialPrompt
    let text = ""
    let lastInputTokens = 0
    let totalOutputTokens = 0
    let toolCallCount = 0
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
      text = response.text

      const finish = response.content.find((p) => p.type === "finish")
      if (finish !== undefined && finish.type === "finish") {
        lastInputTokens = finish.usage.inputTokens.total ?? 0
        totalOutputTokens += finish.usage.outputTokens.total ?? 0
      }

      const approvalPart = response.content.find((p) => p.type === "tool-approval-request")
      if (approvalPart !== undefined) {
        yield* Effect.promise(() =>
          agent.appendEvents([eventJson(new JournalErrorEvent({ turn, message: APPROVAL_DISABLED }))]),
        )
        yield* journalHopBatch({ agent, turn, hop, model, parts: response.content, text: response.text })
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

    return { text, lastInputTokens, totalOutputTokens }
  })

  return loop.pipe(
    Effect.ensuring(snapshotWorkspace(agent)),
    Effect.tapCause(journalTurnError(agent, turn)),
  )
}

/** Build one `chat.completion.chunk` frame for this turn from a delta + finish reason. */
const makeChunk = (
  meta: TurnMeta,
  delta: { role?: "assistant"; content?: string },
  finishReason: string | null,
): ChatCompletionChunk =>
  new ChatCompletionChunk({
    id: meta.id,
    object: "chat.completion.chunk",
    created: meta.created,
    model: meta.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })

/**
 * The streaming facade driver: mirrors the SSE queue-driver but emits OpenAI
 * `chat.completion.chunk` frames (role → content deltas → terminal `stop`),
 * closed by a `[DONE]` sentinel. Journaling is batched at each hop's end
 * (never per-part). Facade turns never park; an approval request is journaled
 * as an error and terminates the turn.
 */
export const streamOpenAiTurn = (input: StreamTurnInput): HttpServerResponse.HttpServerResponse => {
  const { agent, ambient, caps, initialPrompt, meta, model, priorSpend, rules, toolkit, toolLayer, turn } = input

  const encodeChunk = Schema.encodeSync(ChatCompletionChunk)
  const turnLayers = makeTurnLayers(agent, turn, rules, toolLayer)

  const sseFrame = (data: string): string =>
    Sse.encoder.write({ _tag: "Event", event: "message", id: undefined, data })

  const chunkStream = Stream.unwrap(
    Effect.gen(function* () {
      const queue = yield* Queue.bounded<
        ChatCompletionChunk,
        AiError.AiError | Cause.TimeoutError | Cause.Done
      >(64)

      const driver = Effect.gen(function* () {
        let promptValue: Prompt.Prompt = initialPrompt
        let totalToolCalls = 0
        let running: SpendTotals = priorSpend

        yield* Queue.offer(queue, makeChunk(meta, { role: "assistant" }, null))

        for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
          if (budgetExceeded(running, caps)) break
          const baseCall = LanguageModel.streamText({ prompt: promptValue, toolkit })
          const withModel = baseCall.pipe(
            Stream.provide(Layer.succeed(OpenRouterLanguageModel.Config, { model })),
          )

          const collected: Array<AiResponse.AnyPart> = []
          let hopText = ""
          let lastFinishReason: AiResponse.FinishReason | undefined
          let approvalRequested = false

          yield* withModel.pipe(
            Stream.runForEach((part) =>
              Effect.gen(function* () {
                collected.push(part)
                switch (part.type) {
                  case "text-delta": {
                    hopText += part.delta
                    yield* Queue.offer(queue, makeChunk(meta, { content: part.delta }, null))
                    return
                  }
                  case "finish": {
                    lastFinishReason = part.reason
                    return
                  }
                  case "tool-call": {
                    totalToolCalls += 1
                    return
                  }
                  case "tool-approval-request": {
                    approvalRequested = true
                    return
                  }
                  default:
                    return
                }
              }),
            ),
            Effect.timeout(MODEL_HOP_TIMEOUT),
          )

          const terminal =
            approvalRequested ||
            lastFinishReason === undefined ||
            !shouldContinueToolLoop(lastFinishReason)

          if (approvalRequested) {
            yield* Effect.promise(() =>
              agent.appendEvents([eventJson(new JournalErrorEvent({ turn, message: APPROVAL_DISABLED }))]),
            )
          }
          const delta = yield* journalHopBatch({
            agent,
            turn,
            hop,
            model,
            parts: collected,
            text: hopText,
            ...(terminal && lastFinishReason !== undefined && !approvalRequested
              ? { done: { finishReason: lastFinishReason, toolCallCount: totalToolCalls } }
              : {}),
          })
          running = addSpend(running, delta)

          if (terminal) break
          promptValue = Prompt.concat(promptValue, Prompt.fromResponseParts(collected))
        }

        yield* Queue.offer(queue, makeChunk(meta, {}, "stop"))
      }).pipe(
        Effect.tapCause((cause) =>
          Effect.promise(() =>
            agent.appendEvents([eventJson(new JournalErrorEvent({ turn, message: Cause.pretty(cause) }))]),
          ).pipe(Effect.catchCause(() => Effect.void)),
        ),
        Effect.ensuring(Queue.end(queue)),
        Effect.tapCause((cause) => Queue.failCause(queue, cause)),
        Effect.forkScoped,
      )

      yield* driver
      return Stream.fromQueue(queue)
    }),
  )

  const bytes = chunkStream.pipe(
    Stream.provide(turnLayers),
    Stream.provideContext(ambient),
    Stream.map((chunk) => sseFrame(JSON.stringify(encodeChunk(chunk)))),
    Stream.concat(Stream.succeed(sseFrame("[DONE]"))),
    Stream.catchCause((cause) =>
      Stream.fromEffect(Effect.logError("openai stream failed", cause)).pipe(Stream.drain),
    ),
    Stream.encodeText,
    Stream.ensuring(snapshotWorkspace(agent)),
  )

  return HttpServerResponse.stream(bytes, {
    contentType: "text/event-stream",
    headers: { "cache-control": "no-cache", "x-accel-buffering": "no" },
  })
}
