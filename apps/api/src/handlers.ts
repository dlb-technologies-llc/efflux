import {
  AgentApi,
  AgentError,
  HistoryResponse,
  Message,
  PromptResponse,
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

          // `Effect.tapCause` on the whole loop persists the user message
          // when the loop fails — same intent as the streaming handler's
          // `Stream.ensuring`. Append failures are swallowed with a logged
          // cause so they don't shadow the original error.
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

              if (!shouldContinueToolLoop(response.finishReason)) break

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

          const result = yield* loop.pipe(
            Effect.ensuring(snapshotWorkspace),
            Effect.tapCause(() =>
              Effect.promise(() =>
                agent.append([{ role: "user", content: payload.message }]),
              ).pipe(Effect.catchCause(() => Effect.void)),
            ),
          )

          const messageCount = yield* Effect.promise(() =>
            agent.append([
              { role: "user", content: payload.message },
              { role: "assistant", content: result.finalText },
            ]),
          )

          return new PromptResponse({
            text: result.finalText,
            finishReason: result.finalFinishReason,
            toolCallCount: result.toolCallCount,
            model: payload.model ?? DEFAULT_MODEL,
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
          const userMessage: { role: "user"; content: string } = {
            role: "user",
            content: payload.message,
          }
          const messages = composeMessages({
            skillBody,
            roleBody,
            history,
            message: payload.message,
          })

          const buffer = yield* Ref.make("")
          const toolCallCount = yield* Ref.make(0)

          // Effect AI's `streamText` runs ONE round per call (model →
          // resolve tool calls → end). We loop here so the model can react
          // to its own tool results. Parts from every iteration flow into a
          // single queue that drives the SSE pipeline below; intermediate
          // `finish: tool-calls` frames are dropped so the FE only sees ONE
          // `done` at the very end.
          //
          // A forked driver fiber owns the iteration: collect parts, decide
          // whether to loop, and push only the parts we want to emit into
          // the queue. `Stream.fromQueue` consumes them downstream — no
          // recursive Stream type inference needed.
          const loopedStream = Stream.unwrap(
            Effect.gen(function* () {
              const queue = yield* Queue.bounded<
                AiResponse.StreamPart<Toolkit.Tools<typeof AgentToolkit>>,
                AiError.AiError | Cause.Done
              >(64)

              const driver = Effect.gen(function* () {
                let promptValue: Prompt.Prompt = Prompt.make(messages)
                for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
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

                  yield* withModel.pipe(
                    Stream.runForEach((part) =>
                      Effect.gen(function* () {
                        collected.push(part)
                        if (part.type === "finish") {
                          lastFinishReason = part.reason
                          // Suppress intermediate finish frames; only the
                          // terminal finish (next branch) reaches the FE.
                          if (shouldContinueToolLoop(part.reason)) return
                        }
                        yield* Queue.offer(queue, part)
                      }),
                    ),
                  )

                  if (
                    lastFinishReason === undefined ||
                    !shouldContinueToolLoop(lastFinishReason)
                  )
                    break
                  promptValue = Prompt.concat(
                    promptValue,
                    Prompt.fromResponseParts(collected),
                  )
                }
              }).pipe(
                Effect.ensuring(Queue.end(queue)),
                Effect.tapCause((cause) => Queue.failCause(queue, cause)),
                Effect.forkScoped,
              )

              yield* driver
              return Stream.fromQueue(queue)
            }),
          )

          const encodeStreamPart = Schema.encodeSync(StreamPart)

          // Persist user + assistant turn as a single DO write so concurrent
          // prompts can't scramble order. Runs in the `Stream.ensuring`
          // finalizer on BOTH success and interrupt; on a fast disconnect
          // with empty buffer we still persist the user message (no orphan
          // reply).
          //
          // Swallow append failures with a logged Cause rather than
          // `Effect.orDie` — a defect inside a Stream finalizer surfaces
          // only as an unhandled defect log, which is worse than an
          // explicit error trail at the point of failure.
          const persistTurn = Effect.gen(function* () {
            const text = yield* Ref.get(buffer)
            const turn: Array<{
              role: "user" | "assistant"
              content: string
            }> =
              text.length === 0
                ? [userMessage]
                : [userMessage, { role: "assistant", content: text }]
            yield* Effect.promise(() => agent.append(turn)).pipe(
              Effect.catchCause((cause) =>
                Effect.logError("Failed to persist chat turn", cause),
              ),
            )
          })

          // Per-request BashRunner bound to this DO instance's `agent.exec`.
          // Provided into the toolkit pipe below to satisfy `BashTool`'s
          // dependency on `BashRunner` without leaking it to the Worker root.
          const bashRunner = makeBashRunnerLayer((command) =>
            agent.exec(command),
          )

          // Turn-end workspace snapshot (durable workspace, #37) — runs in
          // a stream finalizer alongside `persistTurn`, on success and
          // interrupt alike. Swallow-and-log: a snapshot failure must
          // never kill the SSE stream.
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
            // Map each Effect AI Response.StreamPart to our SSE StreamPart.
            // Response.StreamPart uses `type` (not `_tag`). FinishPart's
            // reason field is `reason: FinishReason` (literal union).
            Stream.filterMap(
              Filter.make((part): Result.Result<SseStreamPart, unknown> => {
                switch (part.type) {
                  case "text-delta":
                    return Result.succeed(
                      new StreamPartTextDelta({ delta: part.delta }),
                    )
                  case "tool-call":
                    return Result.succeed(
                      new StreamPartToolCall({
                        id: part.id,
                        name: part.name,
                        params: part.params,
                      }),
                    )
                  case "tool-result":
                    return Result.succeed(
                      new StreamPartToolResult({
                        id: part.id,
                        result: part.result,
                        isFailure: part.isFailure,
                      }),
                    )
                  case "finish":
                    return Result.succeed(
                      new StreamPartDone({
                        finishReason: part.reason,
                        toolCallCount: 0,
                      }),
                    )
                  default:
                    return Result.fail(part)
                }
              }),
            ),
            Stream.tap((part) => {
              if (part._tag === "text-delta")
                return Ref.update(buffer, (s) => s + part.delta)
              if (part._tag === "tool-call")
                return Ref.update(toolCallCount, (n) => n + 1)
              return Effect.void
            }),
            // Inject the live `toolCallCount` into the `done` frame. The
            // `Stream.filterMap` above emits `done` with a placeholder 0
            // because the Ref hasn't been read yet; here we replace it with
            // the value accumulated by the `tap` above (which runs first for
            // every earlier `tool-call` part).
            Stream.mapEffect(
              (part): Effect.Effect<SseStreamPart> =>
                part._tag === "done"
                  ? Ref.get(toolCallCount).pipe(
                      Effect.map(
                        (count) =>
                          new StreamPartDone({
                            finishReason: part.finishReason,
                            toolCallCount: count,
                          }),
                      ),
                    )
                  : Effect.succeed(part),
            ),
            // Wire-level error AND defects → in-band StreamPartError so the
            // FE's Schema.decodeUnknownEffect(StreamPart) decoder accepts
            // them. `Stream.catchCause` (not `Stream.catch`) ensures a
            // defect inside a tool handler also surfaces as an error frame
            // instead of killing the connection mid-stream with no event.
            Stream.catchCause((cause) =>
              Stream.succeed(
                new StreamPartError({
                  message: Cause.pretty(cause),
                }),
              ),
            ),
            Stream.map((part) =>
              Sse.encoder.write({
                _tag: "Event",
                event: "message",
                id: undefined,
                data: JSON.stringify(encodeStreamPart(part)),
              }),
            ),
            Stream.encodeText,
            Stream.ensuring(persistTurn),
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
