import {
  AgentApi,
  HistoryResponse,
  Message,
  PromptResponse,
  StreamPart,
  StreamPartError,
  SubagentTaskResponse,
} from "@effect-flue/shared"
import * as Cloudflare from "alchemy/Cloudflare"
import { Cause, Context, Effect, Ref, Schema, Stream } from "effect"
import { Sse } from "effect/unstable/encoding"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import type Agent from "./Agent.ts"
import {
  DEFAULT_MODEL,
  callOpenRouter,
  streamOpenRouter,
} from "./OpenRouterClient.ts"
import { loadRoleBody, loadSkillBody } from "./Skills.ts"
import { runSubagent } from "./Subagent.ts"

export type AgentNamespace = Cloudflare.DurableObjectNamespace<Agent>

export class AgentStub extends Context.Service<AgentStub, AgentNamespace>()(
  "api/AgentStub",
) {}

export class OpenRouterApiKey extends Context.Service<
  OpenRouterApiKey,
  string
>()("api/OpenRouterApiKey") {}

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

export const AgentHandlers = HttpApiBuilder.group(
  AgentApi,
  "agents",
  (handlers) =>
    handlers
      .handle("prompt", ({ params, payload }) =>
        Effect.gen(function* () {
          const agents = yield* AgentStub
          const apiKey = yield* OpenRouterApiKey
          const agent = agents.getByName(`${params.name}/${params.id}`)

          const history = yield* agent.history().pipe(Effect.orDie)
          const { skillBody, roleBody } = yield* loadOverlay(
            payload.skill,
            payload.role,
          )

          const result = yield* callOpenRouter(
            apiKey,
            payload.model ?? DEFAULT_MODEL,
            composeMessages({
              skillBody,
              roleBody,
              history,
              message: payload.message,
            }),
          ).pipe(
            Effect.tapError((err) =>
              Effect.sync(() =>
                console.error("OpenRouter failed:", err.message),
              ),
            ),
            Effect.orDie,
          )

          const messageCount = yield* agent
            .append([
              { role: "user", content: payload.message },
              { role: "assistant", content: result.text },
            ])
            .pipe(Effect.orDie)

          return new PromptResponse({
            text: result.text,
            finishReason: result.finishReason,
            toolCallCount: 0,
            model: result.model,
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
          const apiKey = yield* OpenRouterApiKey
          const agent = agents.getByName(`${params.name}/${params.id}`)

          const history = yield* agent.history().pipe(Effect.orDie)
          const { skillBody, roleBody } = yield* loadOverlay(
            payload.skill,
            payload.role,
          )
          const userMessage = {
            role: "user" as const,
            content: payload.message,
          }

          const buffer = yield* Ref.make("")
          const controller = new AbortController()

          const upstream = streamOpenRouter({
            apiKey,
            model: payload.model ?? DEFAULT_MODEL,
            messages: composeMessages({
              skillBody,
              roleBody,
              history,
              message: payload.message,
            }),
            signal: controller.signal,
          })

          const encodeStreamPart = Schema.encodeSync(StreamPart)

          // Always abort the upstream fetch when this stream ends or is
          // interrupted, so client disconnects don't keep OpenRouter
          // streaming into a closed socket.
          const abortUpstream = Effect.sync(() => controller.abort())

          // Persist user + assistant turn as a single DO write so concurrent
          // prompts can't scramble order (avoids the window where request B's
          // user message could land between request A's user and assistant
          // writes). Runs in the Stream.ensuring finalizer on BOTH success
          // and interrupt; on a fast disconnect with empty buffer we still
          // persist the user message (no orphan reply).
          //
          // We swallow append failures with a logged Cause rather than
          // Effect.orDie — a defect inside a Stream finalizer surfaces only
          // as an unhandled defect log, which is worse than an explicit
          // error trail at the point of failure.
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

          const sseFrames = upstream.pipe(
            // Wire-level error → in-band StreamPartError so the FE's
            // Schema.decodeUnknownEffect(StreamPart) decoder accepts it.
            Stream.catch((err) =>
              Stream.succeed(
                new StreamPartError({
                  message: err.message ?? "stream failed",
                }),
              ),
            ),
            Stream.tap((part) =>
              part._tag === "text-delta"
                ? Ref.update(buffer, (s) => s + part.delta)
                : Effect.void,
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
            Stream.ensuring(Effect.andThen(abortUpstream, persistTurn)),
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
          const apiKey = yield* OpenRouterApiKey
          const result = yield* runSubagent({
            apiKey,
            prompt: payload.prompt,
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
