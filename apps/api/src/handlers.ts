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
import * as Cloudflare from "alchemy/Cloudflare"
import {
  Cause,
  Context,
  Effect,
  Filter,
  Layer,
  Ref,
  Result,
  Schema,
  Stream,
} from "effect"
import { LanguageModel } from "effect/unstable/ai"
import { Sse } from "effect/unstable/encoding"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import type Agent from "./Agent.ts"
import { DEFAULT_MODEL } from "./Defaults.ts"
import { SkillsBucket, loadRoleBody, loadSkillBody } from "./Skills.ts"
import { runSubagent } from "./Subagent.ts"
import { AgentToolkit, AgentToolkitLayer } from "./Tools.ts"

export type AgentNamespace = Cloudflare.DurableObjectNamespace<Agent>

export class AgentStub extends Context.Service<AgentStub, AgentNamespace>()(
  "api/AgentStub",
) {}

// Compose the OpenRouter message array as
// `[system: skill, system: role?, ...history, user]`.
// System messages are NOT persisted to history — only user + assistant.
const composeMessages = (input: {
  skillBody: string
  roleBody: string | undefined
  history: ReadonlyArray<{ role: "user" | "assistant"; content: string }>
  message: string
}): ReadonlyArray<{
  role: "system" | "user" | "assistant"
  content: string
}> => {
  const systemMessages =
    input.roleBody !== undefined
      ? [
          { role: "system" as const, content: input.skillBody },
          { role: "system" as const, content: input.roleBody },
        ]
      : [{ role: "system" as const, content: input.skillBody }]
  return [
    ...systemMessages,
    ...input.history,
    { role: "user" as const, content: input.message },
  ]
}

// Resolve skill + optional role bodies from R2. Default skill is `"support"`.
// Failures surface as `AgentError` on the endpoint's typed error channel.
const loadOverlay = (skill: string | undefined, role: string | undefined) =>
  Effect.gen(function* () {
    const skillBody = yield* loadSkillBody(skill ?? "support")
    const roleBody = role !== undefined ? yield* loadRoleBody(role) : undefined
    return { skillBody, roleBody }
  })

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

          const history = yield* agent.history().pipe(Effect.orDie)
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

          const generation = LanguageModel.generateText({
            prompt: messages,
            toolkit: AgentToolkit,
          })
          const withModel =
            payload.model !== undefined
              ? OpenRouterLanguageModel.withConfigOverride(generation, {
                  model: payload.model,
                })
              : generation

          const response = yield* withModel.pipe(
            Effect.provide(AgentToolkitLayer),
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
            // Persist the user's message on failure so it isn't lost when
            // the loop fails before producing a reply. Matches the stream
            // handler's `Stream.ensuring` pattern. `Effect.tapCause` is
            // v4's renaming of `Effect.tapErrorCause`. Inner `catchCause`
            // ensures an append failure doesn't shadow the original cause.
            Effect.tapCause(() =>
              agent
                .append([{ role: "user", content: payload.message }])
                .pipe(Effect.catchCause(() => Effect.void)),
            ),
          )

          const toolCallCount = response.toolCalls.length

          const messageCount = yield* agent
            .append([
              { role: "user", content: payload.message },
              { role: "assistant", content: response.text },
            ])
            .pipe(Effect.orDie)

          return new PromptResponse({
            text: response.text,
            finishReason: response.finishReason,
            toolCallCount,
            model: payload.model ?? DEFAULT_MODEL,
            messageCount,
          })
        }),
      )
      .handle("history", ({ params }) =>
        Effect.gen(function* () {
          const agents = yield* AgentStub
          const agent = agents.getByName(`${params.name}/${params.id}`)
          const history = yield* agent.history().pipe(Effect.orDie)
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
          yield* agent.reset().pipe(Effect.orDie)
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

          const history = yield* agent.history().pipe(Effect.orDie)
          const { skillBody, roleBody } = yield* loadOverlay(
            payload.skill,
            payload.role,
          )
          const userMessage = {
            role: "user" as const,
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

          const generation = LanguageModel.streamText({
            prompt: messages,
            toolkit: AgentToolkit,
          })
          // `withConfigOverride` does NOT accept Stream; override Config
          // via Layer instead.
          const withModel =
            payload.model !== undefined
              ? generation.pipe(
                  Stream.provide(
                    Layer.succeed(OpenRouterLanguageModel.Config, {
                      model: payload.model,
                    }),
                  ),
                )
              : generation

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
            const turn =
              text.length === 0
                ? [userMessage]
                : [userMessage, { role: "assistant" as const, content: text }]
            yield* agent.append(turn).pipe(
              Effect.catchCause((cause) =>
                Effect.sync(() =>
                  console.error(
                    "Failed to persist chat turn:",
                    Cause.pretty(cause),
                  ),
                ),
              ),
            )
          })

          const sseFrames = withModel.pipe(
            Stream.provide(AgentToolkitLayer),
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
            // Wire-level error → in-band StreamPartError so the FE's
            // Schema.decodeUnknownEffect(StreamPart) decoder accepts it.
            Stream.catch((err: { readonly message?: string }) =>
              Stream.succeed(
                new StreamPartError({
                  message: err.message ?? "stream failed",
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
