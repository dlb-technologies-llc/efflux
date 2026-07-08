import {
  AgentApi,
  AgentError,
  HistoryResponse,
  JournalAssistantText,
  JournalDone,
  JournalErrorEvent,
  JournalEvent,
  JournalEventPayload,
  JournalHopMessages,
  JournalResponse,
  JournalToolCall,
  JournalToolResult,
  JournalUsage,
  JournalUserMessage,
  Message,
  PromptResponse,
  SessionInfo,
  SessionsResponse,
  StreamPart,
  StreamPartDone,
  StreamPartError,
  StreamPartTextDelta,
  StreamPartToolCall,
  StreamPartToolResult,
  SubagentTaskResponse,
} from "@effect-flue/shared"
import * as OpenRouterLanguageModel from "@effect/ai-openrouter/OpenRouterLanguageModel"
import {
  Cause,
  Context,
  Effect,
  Filter,
  Layer,
  Queue,
  Ref,
  Result,
  Schema,
  Stream,
} from "effect"
import * as AiError from "effect/unstable/ai/AiError"
import {
  LanguageModel,
  Prompt,
  Response as AiResponse,
  Toolkit,
} from "effect/unstable/ai"
import { Sse } from "effect/unstable/encoding"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { Agent } from "./Agent.ts"
import {
  MAX_TOOL_HOPS,
  composeMessages,
  loadOverlay,
  makeBashRunnerLayer,
  shouldContinueToolLoop,
} from "./AgentLoop.ts"
import { DEFAULT_MODEL } from "./Defaults.ts"
import { RegistryStub } from "./Registry.ts"
import type { SkillsBucket } from "./Skills.ts"
import { runSubagent } from "./Subagent.ts"
import { AgentToolkit, AgentToolkitLayer } from "./Tools.ts"

// Native DO namespace binding (global type from worker-configuration.d.ts).
// The `Agent` generic gives `getByName(...)` a typed RPC stub whose methods
// return `Promise`s — call sites wrap them in `Effect.promise` below.
export type AgentNamespace = DurableObjectNamespace<Agent>

export class AgentStub extends Context.Service<AgentStub, AgentNamespace>()(
  "api/AgentStub",
) {}

// Discriminated union of our SSE-bound StreamPart variants. Used to type
// the post-filterMap stream so subsequent `Stream.tap`/`Stream.map`
// operators see `_tag` for narrowing.
type SseStreamPart =
  | StreamPartTextDelta
  | StreamPartToolCall
  | StreamPartToolResult
  | StreamPartDone
  | StreamPartError

// An SSE frame candidate: the display part plus the journal seq of the
// event backing it (undefined for text deltas, which ride the most recent
// journaled seq instead).
type FramedPart = { sse: SseStreamPart; seq: number | undefined }

const encodeEventPayload = Schema.encodeSync(JournalEventPayload)
const decodeEventPayload = Schema.decodeUnknownEffect(JournalEventPayload)

// Journal payloads cross the DO RPC fence as schema-Encoded JSON text (the
// DO validates and stores it verbatim). See ISSUES.md on the RPC boundary.
const eventJson = (event: JournalEventPayload): string =>
  JSON.stringify(encodeEventPayload(event))

/**
 * Build the granular tool events + the authoritative `hop-messages` event
 * for one hop from its collected response parts.
 *
 * `Prompt.fromResponseParts` is the canonical response→prompt mapping
 * (part ordering, reasoning parts, `encodedResult`, preliminary-result
 * skip) — the granular events are extracted from ITS output so the two
 * journal layers can never disagree.
 */
const buildHopEvents = (input: {
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
      new JournalHopMessages({
        turn: input.turn,
        hop: input.hop,
        messages,
      }),
    )
  }
  return events
}

// OpenRouter's raw usage accounting carries `cost` (USD) when the account
// has usage tracking — the generated TS type omits it, so extract it
// schema-first from the finish part's provider metadata (v4 Struct decode
// ignores the other raw-usage fields).
const OpenRouterCostSchema = Schema.Struct({
  cost: Schema.optionalKey(Schema.Number),
})
const decodeOpenRouterCost = Schema.decodeUnknownResult(OpenRouterCostSchema)

/**
 * Usage event for one hop, from its `finish` part: typed token counts plus
 * OpenRouter's raw cost accounting (USD) when the provider reports it.
 * Returns undefined when the hop produced no finish part.
 */
const buildUsageEvent = (input: {
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

// The `user-message` event opens the turn: its seq is the turn id stamped
// on every subsequent event, and journaling it BEFORE the model call means
// a failed or disconnected turn still leaves no orphan state.
const openTurn = (
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
      return yield* Effect.fail(
        new AgentError({ message: "journal append returned no seq" }),
      )
    }
    return turn
  })

export const AgentHandlers = HttpApiBuilder.group(
  AgentApi,
  "agents",
  (handlers) =>
    handlers
      .handle("prompt", ({ params, payload }) =>
        Effect.gen(function* () {
          const agents = yield* AgentStub
          const agent = agents.getByName(`${params.name}/${params.id}`)

          const history = yield* Effect.promise(() => agent.history())
          const { skillBody, roleBody } = yield* loadOverlay(
            payload.skill,
            payload.role,
          )

          const messages = composeMessages({
            skillBody,
            roleBody,
            history,
            message: payload.message,
          })

          // Per-request BashRunner bound to this DO instance's `agent.exec`.
          // Provided into the toolkit pipe below to satisfy `BashTool`'s
          // dependency on `BashRunner` without leaking it to the Worker root.
          const bashRunner = makeBashRunnerLayer((command) =>
            agent.exec(command),
          )

          const turn = yield* openTurn(agent, payload)
          const model = payload.model ?? DEFAULT_MODEL

          // Turn-end workspace snapshot (durable workspace, #37). Every
          // exec happens inside `loop`, so an `Effect.ensuring` on it runs
          // after the workspace is final for this turn — on success AND
          // failure. Swallow-and-log: a snapshot failure must never shadow
          // the response.
          const snapshotWorkspace = Effect.promise(() =>
            agent.snapshotIfDirty(),
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Workspace snapshot failed", cause),
            ),
            Effect.asVoid,
          )

          const loop = Effect.gen(function* () {
            let promptValue: Prompt.Prompt = Prompt.make(messages)
            let finalText = ""
            let finalFinishReason: AiResponse.FinishReason = "unknown"
            let toolCallCount = 0

            for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
              const call = LanguageModel.generateText({
                prompt: promptValue,
                toolkit: AgentToolkit,
              })
              const withModel =
                payload.model !== undefined
                  ? OpenRouterLanguageModel.withConfigOverride(call, {
                      model: payload.model,
                    })
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
              // Carry the latest text forward — once `finishReason` lands on
              // a terminal state the loop exits and we persist this value.
              finalText = response.text
              finalFinishReason = response.finishReason

              const terminal = !shouldContinueToolLoop(response.finishReason)

              // One batched journal write per hop: granular tool events,
              // the authoritative hop-messages, display text, usage — and
              // `done` when this hop ends the turn.
              const hopEvents = buildHopEvents({
                turn,
                hop,
                parts: response.content,
              })
              if (response.text.length > 0) {
                hopEvents.push(
                  new JournalAssistantText({ turn, hop, text: response.text }),
                )
              }
              const usageEvent = buildUsageEvent({
                turn,
                hop,
                model,
                parts: response.content,
              })
              if (usageEvent !== undefined) hopEvents.push(usageEvent)
              if (terminal || hop === MAX_TOOL_HOPS - 1) {
                hopEvents.push(
                  new JournalDone({
                    turn,
                    finishReason: response.finishReason,
                    toolCallCount,
                  }),
                )
              }
              if (hopEvents.length > 0) {
                yield* Effect.promise(() =>
                  agent.appendEvents(hopEvents.map(eventJson)),
                )
              }

              if (terminal) break

              // Feed the assistant tool-call message + tool-result messages
              // back into the prompt so the next iteration lets the model
              // see what its tool calls returned.
              promptValue = Prompt.concat(
                promptValue,
                Prompt.fromResponseParts(response.content),
              )
            }

            return { finalText, finalFinishReason, toolCallCount }
          })

          // The user message is already journaled (turn opened above), so a
          // failed loop leaves no orphan state — just record the error.
          // Journal failures are swallowed so they don't shadow the
          // original error.
          const result = yield* loop.pipe(
            Effect.ensuring(snapshotWorkspace),
            Effect.tapCause((cause) =>
              Effect.promise(() =>
                agent.appendEvents([
                  eventJson(
                    new JournalErrorEvent({
                      turn,
                      message: Cause.pretty(cause),
                    }),
                  ),
                ]),
              ).pipe(Effect.catchCause(() => Effect.void)),
            ),
          )

          // Pre-journal semantics: `append` returned the post-turn history
          // length; the fold yields the same value as the turn-start fetch
          // plus this turn's user + assistant messages.
          const messageCount =
            history.length + (result.finalText.length > 0 ? 2 : 1)

          return new PromptResponse({
            text: result.finalText,
            finishReason: result.finalFinishReason,
            toolCallCount: result.toolCallCount,
            model,
            messageCount,
          })
        }),
      )
      .handle("history", ({ params }) =>
        Effect.gen(function* () {
          const agents = yield* AgentStub
          const agent = agents.getByName(`${params.name}/${params.id}`)
          const history = yield* Effect.promise(() => agent.history())
          return new HistoryResponse({
            history: history.map(
              (m) => new Message({ role: m.role, content: m.content }),
            ),
          })
        }),
      )
      .handle("reset", ({ params }) =>
        Effect.gen(function* () {
          const agents = yield* AgentStub
          const agent = agents.getByName(`${params.name}/${params.id}`)
          yield* Effect.promise(() => agent.reset())
        }),
      )
      .handle("journal", ({ params, query }) =>
        Effect.gen(function* () {
          const agents = yield* AgentStub
          const agent = agents.getByName(`${params.name}/${params.id}`)
          const after = query.after ?? 0
          const limit = Math.min(Math.max(query.limit ?? 100, 1), 500)
          const page = yield* Effect.promise(() =>
            agent.readJournal({ after, limit }),
          )
          // Payload decode failures die: rows were validated at append
          // time, so corruption here is a bug, not a client error.
          const events = yield* Effect.forEach(page.events, (row) =>
            decodeEventPayload(JSON.parse(row.payload)).pipe(
              Effect.map(
                (event) =>
                  new JournalEvent({
                    seq: row.seq,
                    createdAt: row.createdAt,
                    event,
                  }),
              ),
              Effect.orDie,
            ),
          )
          return new JournalResponse({ events, nextAfter: page.nextAfter })
        }),
      )
      .handle("sessions", () =>
        Effect.gen(function* () {
          const registry = yield* RegistryStub
          const stub = registry.get(registry.idFromName("global"))
          // Rebuild class instances from the plain RPC rows — Schema.Class
          // instances cannot cross the DO fence. See ISSUES.md.
          const rows = yield* Effect.promise(() => stub.list())
          return new SessionsResponse({
            sessions: rows.map(
              (row) =>
                new SessionInfo({
                  name: row.name,
                  id: row.id,
                  createdAt: row.createdAt,
                  lastActiveAt: row.lastActiveAt,
                }),
            ),
          })
        }),
      )
      .handle("stream", ({ params, payload }) =>
        Effect.gen(function* () {
          const agents = yield* AgentStub
          const agent = agents.getByName(`${params.name}/${params.id}`)

          // Capture the outer Effect's context so we can provide
          // `LanguageModel` and `SkillsBucket` (consumed by the toolkit
          // layer's `RIn`) into the SSE Stream. Without this, the Stream
          // would carry those services in `R` and fail `HttpServerResponse
          // .stream`'s `R = never` requirement.
          const ambient = yield* Effect.context<
            LanguageModel.LanguageModel | SkillsBucket
          >()

          const history = yield* Effect.promise(() => agent.history())
          const { skillBody, roleBody } = yield* loadOverlay(
            payload.skill,
            payload.role,
          )
          const messages = composeMessages({
            skillBody,
            roleBody,
            history,
            message: payload.message,
          })

          // Open the turn before any model work: the user message is
          // journaled first (its seq = the turn id and the initial SSE
          // frame id), so a fast disconnect leaves no orphan state.
          const turn = yield* openTurn(agent, payload)
          const model = payload.model ?? DEFAULT_MODEL

          const toolCallCount = yield* Ref.make(0)
          // Most recent journaled seq — text-delta frames (which have no
          // backing event) carry this as their SSE id, so replaying the
          // journal from any frame id reproduces the folded state.
          const lastSeq = yield* Ref.make(turn)

          // Partial-hop text accumulator shared with the finalizers: on
          // disconnect or mid-hop failure, whatever text streamed so far is
          // flushed as an `assistant-text` event (the pre-journal code
          // persisted partial turns the same way).
          let pendingHopText = ""
          let currentHop = 0

          // Once-only flush of the partial hop text, for MID-HOP FAILURE
          // endings (e.g. the model API dying between deltas) — those run
          // finalizers normally. It deliberately does NOT try to cover
          // client disconnect: workerd fires neither `request.signal`
          // abort nor a prompt stream cancel when the client drops
          // (verified live — see ISSUES.md "Client disconnect mid-SSE"),
          // so no finalizer can run there. Instead the driver simply keeps
          // going server-side, and the inline tool-event appends + hop-end
          // batches preserve the turn's state until the runtime reaps the
          // context; a turn with no `done` event reads as
          // parked/incomplete, which is the designed semantic.
          const flushPartialHopText = Effect.suspend(() => {
            if (pendingHopText.length === 0) return Effect.void
            const text = pendingHopText
            pendingHopText = ""
            return Effect.promise(() =>
              agent.appendEvents([
                eventJson(
                  new JournalAssistantText({
                    turn,
                    hop: currentHop,
                    text,
                  }),
                ),
              ]),
            ).pipe(
              Effect.catchCause((cause) =>
                Effect.logError("Failed to flush partial hop text", cause),
              ),
              Effect.asVoid,
            )
          })

          // Effect AI's `streamText` runs ONE round per call (model →
          // resolve tool calls → end). We loop here so the model can react
          // to its own tool results. Parts from every iteration flow into a
          // single queue that drives the SSE pipeline below; intermediate
          // `finish: tool-calls` frames are dropped so the FE only sees ONE
          // `done` at the very end.
          //
          // A forked driver fiber owns the iteration AND the journaling:
          // tool-call/tool-result events are appended inline as their parts
          // arrive (their seqs ride the frames), and each hop ends with one
          // batched append of hop-messages + assistant-text + usage (+ done
          // on the terminal hop, whose seq rides the finish frame).
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
                let promptValue: Prompt.Prompt = Prompt.make(messages)
                let totalToolCalls = 0
                for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
                  currentHop = hop
                  pendingHopText = ""
                  const baseCall = LanguageModel.streamText({
                    prompt: promptValue,
                    toolkit: AgentToolkit,
                  })
                  const withModel =
                    payload.model !== undefined
                      ? baseCall.pipe(
                          Stream.provide(
                            Layer.succeed(OpenRouterLanguageModel.Config, {
                              model: payload.model,
                            }),
                          ),
                        )
                      : baseCall

                  const collected: Array<AiResponse.AnyPart> = []
                  let lastFinishReason: AiResponse.FinishReason | undefined
                  let finishPart:
                    | AiResponse.StreamPart<Toolkit.Tools<typeof AgentToolkit>>
                    | undefined

                  yield* withModel.pipe(
                    Stream.runForEach((part) =>
                      Effect.gen(function* () {
                        collected.push(part)
                        switch (part.type) {
                          case "text-delta": {
                            pendingHopText += part.delta
                            yield* Queue.offer(queue, {
                              part,
                              seq: undefined,
                            })
                            return
                          }
                          case "finish": {
                            lastFinishReason = part.reason
                            // Never offered here: intermediate finishes are
                            // suppressed entirely, and the terminal finish
                            // is offered after the hop batch so its frame
                            // carries the `done` event's seq.
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
                                      providerExecuted:
                                        part.providerExecuted ?? false,
                                    }),
                                  }),
                                ),
                              ]),
                            )
                            yield* Queue.offer(queue, { part, seq: seqs[0] })
                            return
                          }
                          case "tool-result": {
                            // Preliminary results still stream to the FE
                            // but are never journaled — matches
                            // `Prompt.fromResponseParts`.
                            if (part.preliminary === true) {
                              yield* Queue.offer(queue, {
                                part,
                                seq: undefined,
                              })
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
                            yield* Queue.offer(queue, {
                              part,
                              seq: undefined,
                            })
                          }
                        }
                      }),
                    ),
                  )

                  const terminal =
                    lastFinishReason === undefined ||
                    !shouldContinueToolLoop(lastFinishReason)

                  // Hop-end batch. `done` is journaled only on a terminal
                  // finish — a hop-cap truncation stays silent (pre-#31
                  // semantic, matching the suppressed finish frame) and the
                  // journal reads as parked/incomplete.
                  const hopEvents: Array<JournalEventPayload> = []
                  const hopMessages = Prompt.fromResponseParts(collected)
                    .content
                  if (hopMessages.length > 0) {
                    hopEvents.push(
                      new JournalHopMessages({
                        turn,
                        hop,
                        messages: hopMessages,
                      }),
                    )
                  }
                  if (pendingHopText.length > 0) {
                    hopEvents.push(
                      new JournalAssistantText({
                        turn,
                        hop,
                        text: pendingHopText,
                      }),
                    )
                  }
                  const usageEvent = buildUsageEvent({
                    turn,
                    hop,
                    model,
                    parts: collected,
                  })
                  if (usageEvent !== undefined) hopEvents.push(usageEvent)
                  if (terminal && lastFinishReason !== undefined) {
                    hopEvents.push(
                      new JournalDone({
                        turn,
                        finishReason: lastFinishReason,
                        toolCallCount: totalToolCalls,
                      }),
                    )
                  }
                  const seqs =
                    hopEvents.length > 0
                      ? yield* Effect.promise(() =>
                          agent.appendEvents(hopEvents.map(eventJson)),
                        )
                      : []
                  // Journaled — the finalizer must not flush it again.
                  pendingHopText = ""

                  if (terminal) {
                    if (finishPart !== undefined) {
                      yield* Queue.offer(queue, {
                        part: finishPart,
                        seq: seqs[seqs.length - 1],
                      })
                    }
                    break
                  }
                  promptValue = Prompt.concat(
                    promptValue,
                    Prompt.fromResponseParts(collected),
                  )
                }
              }).pipe(
                // Flush partial hop text on driver failure BEFORE the queue
                // closes (the response-stream finalizer below covers the
                // disconnect path).
                Effect.ensuring(flushPartialHopText),
                Effect.ensuring(Queue.end(queue)),
                Effect.tapCause((cause) => Queue.failCause(queue, cause)),
                Effect.forkScoped,
              )

              yield* driver
              return Stream.fromQueue(queue)
            }),
          )

          const encodeStreamPart = Schema.encodeSync(StreamPart)

          // Per-request BashRunner bound to this DO instance's `agent.exec`.
          // Provided into the toolkit pipe below to satisfy `BashTool`'s
          // dependency on `BashRunner` without leaking it to the Worker root.
          const bashRunner = makeBashRunnerLayer((command) =>
            agent.exec(command),
          )

          // Turn-end workspace snapshot (durable workspace, #37) — runs in
          // a stream finalizer alongside the partial-text flush on normal
          // completion and mid-hop failure (NOT on client disconnect —
          // workerd runs no finalizers there; see ISSUES.md).
          // Swallow-and-log: a snapshot failure must never kill the SSE
          // stream.
          const snapshotWorkspace = Effect.promise(() =>
            agent.snapshotIfDirty(),
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Workspace snapshot failed", cause),
            ),
            Effect.asVoid,
          )

          const sseFrames = loopedStream.pipe(
            Stream.provide(AgentToolkitLayer),
            Stream.provide(bashRunner),
            // Provide the ambient services consumed by the toolkit layer's
            // `RIn` (LanguageModel + SkillsBucket). These are satisfied
            // upstream at the Worker root (`aiLayer` + per-event
            // `provideService(SkillsBucket, ...)`).
            Stream.provideContext(ambient),
            // Map each Effect AI Response.StreamPart to our SSE StreamPart,
            // carrying the backing journal seq through. Response.StreamPart
            // uses `type` (not `_tag`); FinishPart's reason field is
            // `reason: FinishReason` (literal union).
            Stream.filterMap(
              Filter.make(
                (el): Result.Result<FramedPart, unknown> => {
                  const part = el.part
                  switch (part.type) {
                    case "text-delta":
                      return Result.succeed({
                        sse: new StreamPartTextDelta({ delta: part.delta }),
                        seq: el.seq,
                      })
                    case "tool-call":
                      return Result.succeed({
                        sse: new StreamPartToolCall({
                          id: part.id,
                          name: part.name,
                          params: part.params,
                        }),
                        seq: el.seq,
                      })
                    case "tool-result":
                      return Result.succeed({
                        sse: new StreamPartToolResult({
                          id: part.id,
                          result: part.result,
                          isFailure: part.isFailure,
                        }),
                        seq: el.seq,
                      })
                    case "finish":
                      return Result.succeed({
                        sse: new StreamPartDone({
                          finishReason: part.reason,
                          toolCallCount: 0,
                        }),
                        seq: el.seq,
                      })
                    default:
                      return Result.fail(part)
                  }
                },
              ),
            ),
            Stream.tap(({ sse }) =>
              sse._tag === "tool-call"
                ? Ref.update(toolCallCount, (n) => n + 1)
                : Effect.void,
            ),
            // Inject the live `toolCallCount` into the `done` frame. The
            // `Stream.filterMap` above emits `done` with a placeholder 0
            // because the Ref hasn't been read yet; here we replace it with
            // the value accumulated by the `tap` above (which runs first
            // for every earlier `tool-call` part).
            Stream.mapEffect((el): Effect.Effect<FramedPart> => {
              const sse = el.sse
              return sse._tag === "done"
                ? Ref.get(toolCallCount).pipe(
                    Effect.map((count) => ({
                      sse: new StreamPartDone({
                        finishReason: sse.finishReason,
                        toolCallCount: count,
                      }),
                      seq: el.seq,
                    })),
                  )
                : Effect.succeed(el)
            }),
            // Wire-level error AND defects → in-band StreamPartError so the
            // FE's Schema.decodeUnknownEffect(StreamPart) decoder accepts
            // them. `Stream.catchCause` (not `Stream.catch`) ensures a
            // defect inside a tool handler also surfaces as an error frame
            // instead of killing the connection mid-stream with no event.
            // The error is journaled HERE (not only in the driver) so
            // defects arising downstream of the driver still land in the
            // journal, and the frame carries the error event's seq.
            Stream.catchCause((cause) =>
              Stream.unwrap(
                Effect.gen(function* () {
                  const seqs = yield* Effect.promise(() =>
                    agent.appendEvents([
                      eventJson(
                        new JournalErrorEvent({
                          turn,
                          message: Cause.pretty(cause),
                        }),
                      ),
                    ]),
                  ).pipe(
                    Effect.catchCause(() =>
                      Effect.succeed<Array<number>>([]),
                    ),
                  )
                  const frame: FramedPart = {
                    sse: new StreamPartError({
                      message: Cause.pretty(cause),
                    }),
                    seq: seqs[0],
                  }
                  return Stream.succeed(frame)
                }),
              ),
            ),
            // Every frame carries an SSE id: the backing event's seq, or
            // the most recent journaled seq for frames without one.
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

          return HttpServerResponse.stream(sseFrames, {
            contentType: "text/event-stream",
            headers: {
              "cache-control": "no-cache",
              "x-accel-buffering": "no",
            },
          })
        }),
      )
      .handle("task", ({ payload }) =>
        Effect.gen(function* () {
          const result = yield* runSubagent({
            prompt: payload.prompt,
            ...(payload.skill !== undefined ? { skill: payload.skill } : {}),
            ...(payload.role !== undefined ? { role: payload.role } : {}),
            ...(payload.model !== undefined ? { model: payload.model } : {}),
          })
          return new SubagentTaskResponse({
            text: result.text,
            model: result.model,
            finishReason: result.finishReason,
          })
        }),
      ),
)
