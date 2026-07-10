import {
  JournalApprovalRequested,
  JournalAssistantText,
  JournalDone,
  JournalErrorEvent,
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
} from "@effect-flue/shared"
import * as OpenRouterLanguageModel from "@effect/ai-openrouter/OpenRouterLanguageModel"
import { Cause, type Context, Effect, Filter, Layer, Queue, Ref, Result, Schema, Stream } from "effect"
import { LanguageModel, Prompt, type Response as AiResponse, type Toolkit } from "effect/unstable/ai"
import type * as AiError from "effect/unstable/ai/AiError"
import { Sse } from "effect/unstable/encoding"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import {
  MAX_TOOL_HOPS,
  MODEL_HOP_TIMEOUT,
  makeBashRunnerLayer,
  shouldContinueToolLoop,
  snapshotWorkspace,
} from "./AgentLoop.ts"
import type { AgentNamespace } from "./AgentStub.ts"
import { buildUsageEvent, eventJson } from "./JournalWrite.ts"
import type { KnowledgeSearch } from "./Knowledge.ts"
import type { SessionToolkit } from "./SessionToolkit.ts"
import type { SkillsBucket } from "./Skills.ts"
import { makeTodoStoreLayer } from "./Todo.ts"
import { ApprovalRules } from "./Tools.ts"

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
  /** Resolved per-tool permission rules for this turn; provided into the stream as the ApprovalRules Reference. */
  rules: RulesMap
  /** The merged session toolkit (local `AgentToolkit` folded with the resolved MCP tools) driving `streamText` this turn. */
  toolkit: SessionToolkit["toolkit"]
  /** The matching merged handler layer for `toolkit`, provided into the stream for tool execution. */
  toolLayer: SessionToolkit["toolLayer"]
}

/**
 * The streaming-turn driver shared by `stream` (fresh turn, `startHop` 0) and `approve`
 * (continuation of a parked turn). Owns the forked queue driver, per-hop journaling, and the
 * SSE pipeline, looping until a terminal finish or the hop cap with intermediate finishes
 * suppressed. A `tool-approval-request` PARKS the turn (journaled, `approval-request` emitted,
 * no `done`). On client disconnect workerd runs no finalizers (see ISSUES.md) — the inline
 * appends and hop-end batches persist the turn regardless.
 */
export const runStreamingTurn = (
  input: RunStreamingTurnInput,
): HttpServerResponse.HttpServerResponse => {
  const { agent, ambient, initialPrompt, model, rules, startHop, toolkit, toolLayer, turn } = input

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

  const bashRunner = makeBashRunnerLayer((command) => agent.exec(command))
  const todoStore = makeTodoStoreLayer(agent, turn)

  const sseFrames = Stream.unwrap(
    Effect.gen(function* () {
      const toolCallCount = yield* Ref.make(0)
      const lastSeq = yield* Ref.make(turn)

      const loopedStream = Stream.unwrap(
        Effect.gen(function* () {
          const queue = yield* Queue.bounded<
            {
              part: AiResponse.StreamPart<Toolkit.Tools<SessionToolkit["toolkit"]>>
              seq: number | undefined
            },
            AiError.AiError | Cause.TimeoutError | Cause.Done
          >(64)

          const driver = Effect.gen(function* () {
            let promptValue: Prompt.Prompt = initialPrompt
            let totalToolCalls = 0
            let parked = false
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
                if (!parked && finishPart !== undefined) {
                  yield* Queue.offer(queue, { part: finishPart, seq: seqs[seqs.length - 1] })
                }
                break
              }
              promptValue = Prompt.concat(promptValue, Prompt.fromResponseParts(collected))
            }
          }).pipe(
            Effect.ensuring(flushPartialHopText),
            Effect.ensuring(Queue.end(queue)),
            Effect.tapCause((cause) => Queue.failCause(queue, cause)),
            Effect.forkScoped,
          )

          yield* driver
          return Stream.fromQueue(queue)
        }),
      )

      return loopedStream.pipe(
        Stream.provide(toolLayer),
        Stream.provide(bashRunner),
        Stream.provide(todoStore),
        Stream.provide(Layer.succeed(ApprovalRules, rules)),
        Stream.provideContext(ambient),
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
          Stream.unwrap(
            Effect.gen(function* () {
              const seqs = yield* Effect.promise(() =>
                agent.appendEvents([eventJson(new JournalErrorEvent({ turn, message: Cause.pretty(cause) }))]),
              ).pipe(Effect.catchCause(() => Effect.succeed<Array<number>>([])))
              return Stream.succeed<FramedPart>({
                sse: new StreamPartError({ message: Cause.pretty(cause) }),
                seq: seqs[0],
              })
            }),
          ),
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
        Stream.ensuring(snapshotWorkspace(agent)),
      )
    }),
  )

  return HttpServerResponse.stream(sseFrames, {
    contentType: "text/event-stream",
    headers: { "cache-control": "no-cache", "x-accel-buffering": "no" },
  })
}

/** Map one Effect AI response part to an SSE StreamPart carrying its backing journal seq; unknown parts and a seq-less `tool-approval-request` are dropped. */
const toFramedPart = (el: {
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
