import {
  JournalApprovalRequested,
  JournalAssistantText,
  JournalDone,
  type JournalEventPayload,
  JournalHopMessages,
  JournalToolCall,
  JournalToolResult,
  type RulesMap,
  StreamPart,
  StreamPartApprovalRequest,
  StreamPartDone,
  StreamPartError,
  StreamPartTextDelta,
  StreamPartToolCall,
  StreamPartToolResult,
} from "@efflux/shared"
import * as OpenRouterLanguageModel from "@effect/ai-openrouter/OpenRouterLanguageModel"
import { Cause, type Context, Effect, Filter, Layer, Queue, Ref, Result, Schema, Stream } from "effect"
import { LanguageModel, Prompt, type Response as AiResponse, type Toolkit } from "effect/unstable/ai"
import type * as AiError from "effect/unstable/ai/AiError"
import { Sse } from "effect/unstable/encoding"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import {
  journalTurnError,
  MAX_TOOL_HOPS,
  MODEL_HOP_TIMEOUT,
  makeTurnLayers,
  shouldContinueToolLoop,
  snapshotWorkspace,
} from "./AgentLoop.ts"
import type { AgentNamespace } from "./AgentStub.ts"
import { buildUsageEvent, eventJson } from "./JournalWrite.ts"
import type { KnowledgeSearch } from "./Knowledge.ts"
import type { SessionToolkit } from "./SessionToolkit.ts"
import type { SkillsBucket } from "./Skills.ts"

/** The SSE-bound StreamPart union, kept in lockstep with the wire contract. */
type SseStreamPart = StreamPart

/** An SSE frame candidate: the display part plus the journal seq backing it (undefined for text deltas, which ride the most recent seq). */
type FramedPart = { sse: SseStreamPart; seq: number | undefined }

interface RunStreamingTurnInput {
  agent: ReturnType<AgentNamespace["getByName"]>
  ambient: Context.Context<LanguageModel.LanguageModel | SkillsBucket | KnowledgeSearch>
  turn: number
  startHop: number
  initialPrompt: Prompt.Prompt
  model: string
  /** Resolved per-tool permission rules for this turn; provided into the driver as the ApprovalRules Reference. */
  rules: RulesMap
  /** The merged session toolkit (local `AgentToolkit` folded with the resolved MCP tools) driving `streamText` this turn. */
  toolkit: SessionToolkit["toolkit"]
  /** The matching merged handler layer for `toolkit`, provided into the driver for tool execution. */
  toolLayer: SessionToolkit["toolLayer"]
  /** Per-request `ExecutionContext.waitUntil`: registering the detached driver's completion keeps the isolate alive so the turn runs to a terminal even after the client disconnects. */
  readonly waitUntil: (promise: Promise<unknown>) => void
}

/**
 * The streaming-turn driver shared by `stream` (fresh turn, `startHop` 0) and `approve`
 * (continuation of a parked turn). The hop-loop driver is DETACHED from the request fiber
 * (`Effect.runPromise` starts a fresh root fiber) and its completion is registered with
 * `waitUntil`, so a client disconnect neither stalls nor aborts the turn — it runs to a
 * terminal regardless. The driver owns its own terminals: it journals a terminal `error`,
 * snapshots the workspace, and closes the queue itself, because the response pipeline no
 * longer runs once the client is gone. The queue is `sliding`, so `Queue.offer` never blocks
 * on a non-reading client. On client disconnect workerd runs no finalizers (see ISSUES.md);
 * the inline appends, hop-end batches, and driver-owned terminals persist the turn regardless.
 */
export const runStreamingTurn = (
  input: RunStreamingTurnInput,
): Effect.Effect<HttpServerResponse.HttpServerResponse> => {
  const { agent, ambient, initialPrompt, model, rules, startHop, toolkit, toolLayer, turn, waitUntil } = input

  let pendingHopText = ""
  let currentHop = startHop

  const flushPartialHopText = Effect.suspend(() => {
    if (pendingHopText.length === 0) return Effect.void
    const text = pendingHopText
    pendingHopText = ""
    return Effect.promise(() =>
      agent.appendEvents([eventJson(new JournalAssistantText({ turn, hop: currentHop, text }))]),
    ).pipe(
      Effect.catchCause((cause) => Effect.logError("Failed to flush partial hop text", cause)),
      Effect.asVoid,
    )
  })

  const encodeStreamPart = Schema.encodeSync(StreamPart)

  const turnLayers = makeTurnLayers(agent, turn, rules, toolLayer)

  return Effect.gen(function* () {
    const toolCallCount = yield* Ref.make(0)
    const lastSeq = yield* Ref.make(turn)

    const queue = yield* Queue.sliding<
      {
        part: AiResponse.StreamPart<Toolkit.Tools<SessionToolkit["toolkit"]>>
        seq: number | undefined
      },
      AiError.AiError | Cause.TimeoutError | Cause.Done
    >(256)

    const hopLoop = Effect.gen(function* () {
      let promptValue: Prompt.Prompt = initialPrompt
      let totalToolCalls = 0
      let parked = false
      let reachedTerminal = false
      let lastFinishPart: AiResponse.StreamPart<Toolkit.Tools<SessionToolkit["toolkit"]>> | undefined
      let lastReason: AiResponse.FinishReason | undefined
      for (let hop = startHop; hop < startHop + MAX_TOOL_HOPS; hop++) {
        currentHop = hop
        pendingHopText = ""
        const baseCall = LanguageModel.streamText({
          prompt: promptValue,
          toolkit,
        })
        const withModel = baseCall.pipe(
          Stream.provide(Layer.succeed(OpenRouterLanguageModel.Config, { model })),
        )

        const collected: Array<AiResponse.AnyPart> = []
        let lastFinishReason: AiResponse.FinishReason | undefined
        let finishPart: AiResponse.StreamPart<Toolkit.Tools<SessionToolkit["toolkit"]>> | undefined

        yield* withModel.pipe(
          Stream.runForEach((part) =>
            Effect.gen(function* () {
              collected.push(part)
              switch (part.type) {
                case "text-delta": {
                  pendingHopText += part.delta
                  yield* Queue.offer(queue, { part, seq: undefined })
                  return
                }
                case "finish": {
                  lastFinishReason = part.reason
                  finishPart = part
                  return
                }
                case "tool-call": {
                  totalToolCalls += 1
                  const seqs = yield* Effect.promise(() =>
                    agent.appendEvents([
                      eventJson(
                        new JournalToolCall({
                          turn,
                          hop,
                          part: Prompt.toolCallPart({
                            id: part.id,
                            name: part.name,
                            params: part.params,
                            providerExecuted: part.providerExecuted ?? false,
                          }),
                        }),
                      ),
                    ]),
                  )
                  yield* Queue.offer(queue, { part, seq: seqs[0] })
                  return
                }
                case "tool-approval-request": {
                  const seqs = yield* Effect.promise(() =>
                    agent.appendEvents([
                      eventJson(
                        new JournalApprovalRequested({
                          turn,
                          hop,
                          approvalId: part.approvalId,
                          toolCallId: part.toolCallId,
                        }),
                      ),
                    ]),
                  )
                  parked = true
                  yield* Queue.offer(queue, { part, seq: seqs[0] })
                  return
                }
                case "tool-result": {
                  if (part.preliminary === true) {
                    yield* Queue.offer(queue, { part, seq: undefined })
                    return
                  }
                  const seqs = yield* Effect.promise(() =>
                    agent.appendEvents([
                      eventJson(
                        new JournalToolResult({
                          turn,
                          hop,
                          part: Prompt.toolResultPart({
                            id: part.id,
                            name: part.name,
                            isFailure: part.isFailure,
                            result: part.encodedResult,
                          }),
                        }),
                      ),
                    ]),
                  )
                  yield* Queue.offer(queue, { part, seq: seqs[0] })
                  return
                }
                default: {
                  yield* Queue.offer(queue, { part, seq: undefined })
                }
              }
            }),
          ),
          Effect.timeout(MODEL_HOP_TIMEOUT),
        )

        const terminal =
          parked || lastFinishReason === undefined || !shouldContinueToolLoop(lastFinishReason)

        const hopEvents: Array<JournalEventPayload> = []
        const hopMessages = Prompt.fromResponseParts(collected).content
        if (hopMessages.length > 0) {
          hopEvents.push(new JournalHopMessages({ turn, hop, messages: hopMessages }))
        }
        if (pendingHopText.length > 0) {
          hopEvents.push(new JournalAssistantText({ turn, hop, text: pendingHopText }))
        }
        const usageEvent = buildUsageEvent({ turn, hop, model, parts: collected })
        if (usageEvent !== undefined) hopEvents.push(usageEvent)
        if (terminal && lastFinishReason !== undefined && !parked) {
          hopEvents.push(
            new JournalDone({ turn, finishReason: lastFinishReason, toolCallCount: totalToolCalls }),
          )
        }
        const seqs =
          hopEvents.length > 0
            ? yield* Effect.promise(() => agent.appendEvents(hopEvents.map(eventJson)))
            : []
        pendingHopText = ""

        if (terminal) {
          reachedTerminal = true
          if (!parked && finishPart !== undefined) {
            yield* Queue.offer(queue, { part: finishPart, seq: seqs[seqs.length - 1] })
          }
          break
        }
        lastFinishPart = finishPart
        lastReason = lastFinishReason
        promptValue = Prompt.concat(promptValue, Prompt.fromResponseParts(collected))
      }
      if (!reachedTerminal) {
        const doneSeqs = yield* Effect.promise(() =>
          agent.appendEvents([
            eventJson(
              new JournalDone({
                turn,
                finishReason: lastReason ?? "tool-calls",
                toolCallCount: totalToolCalls,
              }),
            ),
          ]),
        )
        if (lastFinishPart !== undefined) {
          yield* Queue.offer(queue, { part: lastFinishPart, seq: doneSeqs[0] })
        }
      }
    })

    const driverEffect = hopLoop.pipe(
      Effect.tap(() =>
        flushPartialHopText.pipe(
          Effect.andThen(snapshotWorkspace(agent)),
          Effect.andThen(Queue.end(queue)),
        ),
      ),
      Effect.tapCause((cause) =>
        flushPartialHopText.pipe(
          Effect.andThen(journalTurnError(agent, turn)(cause)),
          Effect.andThen(Queue.failCause(queue, cause)),
          Effect.andThen(snapshotWorkspace(agent)),
        ),
      ),
      Effect.catchCause(() => Effect.void),
      Effect.provide(turnLayers),
      Effect.provideContext(ambient),
    )

    const done = Effect.runPromise(driverEffect)
    waitUntil(done)

    const responseStream = Stream.fromQueue(queue).pipe(
      Stream.filterMap(Filter.make(toFramedPart)),
      Stream.tap(({ sse }) =>
        sse._tag === "tool-call" ? Ref.update(toolCallCount, (n) => n + 1) : Effect.void,
      ),
      Stream.mapEffect((el): Effect.Effect<FramedPart> => {
        const sse = el.sse
        return sse._tag === "done"
          ? Ref.get(toolCallCount).pipe(
              Effect.map((count) => ({
                sse: new StreamPartDone({ finishReason: sse.finishReason, toolCallCount: count }),
                seq: el.seq,
              })),
            )
          : Effect.succeed(el)
      }),
      Stream.catchCause((cause) =>
        Stream.succeed<FramedPart>({
          sse: new StreamPartError({ message: Cause.pretty(cause) }),
          seq: undefined,
        }),
      ),
      Stream.mapEffect(({ seq, sse }) =>
        Effect.gen(function* () {
          if (seq !== undefined) yield* Ref.set(lastSeq, seq)
          const id = seq ?? (yield* Ref.get(lastSeq))
          return Sse.encoder.write({
            _tag: "Event",
            event: "message",
            id: String(id),
            data: JSON.stringify(encodeStreamPart(sse)),
          })
        }),
      ),
      Stream.encodeText,
    )

    return HttpServerResponse.stream(responseStream, {
      contentType: "text/event-stream",
      headers: { "cache-control": "no-cache", "x-accel-buffering": "no" },
    })
  })
}

/** Map one Effect AI response part to an SSE StreamPart carrying its backing journal seq; unknown parts and a seq-less `tool-approval-request` are dropped. */
export const toFramedPart = (el: {
  part: AiResponse.StreamPart<Toolkit.Tools<SessionToolkit["toolkit"]>>
  seq: number | undefined
}): Result.Result<FramedPart, unknown> => {
  const part = el.part
  switch (part.type) {
    case "text-delta":
      return Result.succeed({ sse: new StreamPartTextDelta({ delta: part.delta }), seq: el.seq })
    case "tool-call":
      return Result.succeed({
        sse: new StreamPartToolCall({ id: part.id, name: part.name, params: part.params }),
        seq: el.seq,
      })
    case "tool-result":
      return Result.succeed({
        sse: new StreamPartToolResult({ id: part.id, result: part.result, isFailure: part.isFailure }),
        seq: el.seq,
      })
    case "finish":
      return Result.succeed({
        sse: new StreamPartDone({ finishReason: part.reason, toolCallCount: 0 }),
        seq: el.seq,
      })
    case "tool-approval-request":
      return el.seq === undefined
        ? Result.fail(part)
        : Result.succeed({
            sse: new StreamPartApprovalRequest({
              eventId: el.seq,
              approvalId: part.approvalId,
              toolCallId: part.toolCallId,
            }),
            seq: el.seq,
          })
    default:
      return Result.fail(part)
  }
}
