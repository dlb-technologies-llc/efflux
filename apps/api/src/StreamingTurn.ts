import {
  JournalApprovalRequested,
  JournalAssistantText,
  JournalDone,
  JournalErrorEvent,
  JournalEventPayload,
  JournalHopMessages,
  JournalToolCall,
  JournalToolResult,
  StreamPart,
  StreamPartApprovalRequest,
  StreamPartDone,
  StreamPartError,
  StreamPartTextDelta,
  StreamPartToolCall,
  StreamPartToolResult,
} from "@effect-flue/shared"
import * as OpenRouterLanguageModel from "@effect/ai-openrouter/OpenRouterLanguageModel"
import { Cause, Context, Effect, Filter, Layer, Queue, Ref, Result, Schema, Stream } from "effect"
import { LanguageModel, Prompt, Response as AiResponse, Toolkit } from "effect/unstable/ai"
import * as AiError from "effect/unstable/ai/AiError"
import { Sse } from "effect/unstable/encoding"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { MAX_TOOL_HOPS, makeBashRunnerLayer, shouldContinueToolLoop } from "./AgentLoop.ts"
import type { AgentNamespace } from "./AgentStub.ts"
import { buildUsageEvent, eventJson } from "./JournalWrite.ts"
import type { SkillsBucket } from "./Skills.ts"
import { AgentToolkit, AgentToolkitLayer } from "./Tools.ts"

/** The SSE-bound StreamPart union, kept in lockstep with the wire contract. */
type SseStreamPart = StreamPart

/**
 * An SSE frame candidate: the display part plus the journal seq of the event
 * backing it (undefined for text deltas, which ride the most recent seq).
 */
type FramedPart = { sse: SseStreamPart; seq: number | undefined }

interface RunStreamingTurnInput {
  agent: ReturnType<AgentNamespace["getByName"]>
  ambient: Context.Context<LanguageModel.LanguageModel | SkillsBucket>
  turn: number
  startHop: number
  initialPrompt: Prompt.Prompt
  model: string
  payloadModel: string | undefined
}

/**
 * The streaming-turn driver shared by `stream` (a fresh turn, `startHop` 0) and
 * `approve` (a continuation of a parked turn, `startHop` = maxHop + 1). It owns
 * the forked queue driver, per-hop journaling, and the SSE pipeline, so both
 * entry points produce byte-identical frames for non-approval turns.
 *
 * Effect AI's `streamText` runs one round per call, so the driver loops until a
 * terminal finish or the hop cap; intermediate `finish: tool-calls` frames are
 * suppressed so the client sees exactly one `done`.
 *
 * A `tool-approval-request` part PARKS the turn: it is journaled, an
 * `approval-request` frame is emitted, and the turn ends with no `done`. The
 * request is offered from within a tool fiber and the model's finish is
 * deferred until tool fibers drain, so the driver always sees the park before
 * the finish — suppressing it needs no locking.
 *
 * On client disconnect workerd runs no finalizers (see ISSUES.md); the inline
 * appends and hop-end batches persist the turn regardless, and a turn with no
 * `done` reads as parked/incomplete.
 */
export const runStreamingTurn = (
  input: RunStreamingTurnInput,
): HttpServerResponse.HttpServerResponse => {
  const { agent, ambient, initialPrompt, model, payloadModel, startHop, turn } = input

  // Shared with the finalizers: partial hop text flushed as an `assistant-text`
  // event on mid-hop failure (not disconnect — workerd runs no finalizers).
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

  // Per-request BashRunner bound to this DO's `exec`, satisfying `BashTool`'s
  // dependency without leaking it to the Worker root.
  const bashRunner = makeBashRunnerLayer((command) => agent.exec(command))

  // Turn-end workspace snapshot (#37). Swallow-and-log: a snapshot failure must
  // never kill the SSE stream.
  const snapshotWorkspace = Effect.promise(() => agent.snapshotIfDirty()).pipe(
    Effect.catchCause((cause) => Effect.logError("Workspace snapshot failed", cause)),
    Effect.asVoid,
  )

  // Refs live in the response stream's scope so this stays a pure function.
  const sseFrames = Stream.unwrap(
    Effect.gen(function* () {
      const toolCallCount = yield* Ref.make(0)
      // Frames without a backing event ride the most recent journaled seq, so
      // replaying from any frame id reproduces the folded state.
      const lastSeq = yield* Ref.make(turn)

      const loopedStream = Stream.unwrap(
        Effect.gen(function* () {
          const queue = yield* Queue.bounded<
            {
              part: AiResponse.StreamPart<Toolkit.Tools<typeof AgentToolkit>>
              seq: number | undefined
            },
            AiError.AiError | Cause.Done
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
                toolkit: AgentToolkit,
              })
              // Model override via a fresh Config. There is no base Config at
              // the Worker root, so this REPLACE is a no-op; a real merge would
              // add `Config` to the Stream's `R` and break the `R = never`
              // requirement below (deferred to #42).
              const withModel =
                payloadModel !== undefined
                  ? baseCall.pipe(
                      Stream.provide(Layer.succeed(OpenRouterLanguageModel.Config, { model: payloadModel })),
                    )
                  : baseCall

              const collected: Array<AiResponse.AnyPart> = []
              let lastFinishReason: AiResponse.FinishReason | undefined
              let finishPart: AiResponse.StreamPart<Toolkit.Tools<typeof AgentToolkit>> | undefined

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
                        // Held back: intermediate finishes are dropped, and the
                        // terminal finish is offered after the hop batch so its
                        // frame carries the `done` event's seq.
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
                        // Preliminary results stream to the client but are never
                        // journaled — matches `Prompt.fromResponseParts`.
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
              )

              // A park forces terminal: the turn stops mid-loop awaiting the
              // approval, with no `done` and no finish frame.
              const terminal =
                parked || lastFinishReason === undefined || !shouldContinueToolLoop(lastFinishReason)

              // `done` is journaled only on a terminal, non-parked finish. A
              // hop-cap truncation and a park both stay silent (the journal
              // reads as parked/incomplete).
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
              pendingHopText = "" // journaled — the finalizer must not re-flush

              if (terminal) {
                // On a park the approval-request is already the last frame;
                // otherwise the terminal finish rides the `done` event's seq.
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
        Stream.provide(AgentToolkitLayer),
        Stream.provide(bashRunner),
        // Provide the ambient services the toolkit layer's `RIn` consumes
        // (LanguageModel + SkillsBucket), satisfied at the Worker root.
        Stream.provideContext(ambient),
        Stream.filterMap(Filter.make(toFramedPart)),
        Stream.tap(({ sse }) =>
          sse._tag === "tool-call" ? Ref.update(toolCallCount, (n) => n + 1) : Effect.void,
        ),
        // Replace the `done` frame's placeholder count with the live tally the
        // `tap` above accumulated from every earlier `tool-call`.
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
        // Wire-level errors and defects become in-band error frames (so the
        // client's decoder accepts them) and are journaled here, so defects
        // arising downstream of the driver still land in the journal.
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
        // Every frame carries an SSE id: its backing seq, or the most recent one.
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
        Stream.ensuring(flushPartialHopText),
        Stream.ensuring(snapshotWorkspace),
      )
    }),
  )

  return HttpServerResponse.stream(sseFrames, {
    contentType: "text/event-stream",
    headers: { "cache-control": "no-cache", "x-accel-buffering": "no" },
  })
}

/**
 * Map one Effect AI response part to an SSE StreamPart, carrying its backing
 * journal seq. Response parts use `type` (not `_tag`); unknown parts are
 * dropped. A `tool-approval-request` requires the journal seq that backs it
 * (its eventId); without it the frame is dropped.
 */
const toFramedPart = (el: {
  part: AiResponse.StreamPart<Toolkit.Tools<typeof AgentToolkit>>
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
