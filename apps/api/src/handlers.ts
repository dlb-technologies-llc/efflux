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
import { Context, Effect, Ref, Schema, Stream } from "effect"
import { Sse } from "effect/unstable/encoding"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import type Agent from "./Agent.ts"
import {
  DEFAULT_MODEL,
  callOpenRouter,
  streamOpenRouter,
} from "./OpenRouterClient.ts"
import { runSubagent } from "./Subagent.ts"

export type AgentNamespace = Cloudflare.DurableObjectNamespace<Agent>

export class AgentStub extends Context.Service<AgentStub, AgentNamespace>()(
  "api/AgentStub",
) {}

export class OpenRouterApiKey extends Context.Service<
  OpenRouterApiKey,
  string
>()("api/OpenRouterApiKey") {}

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

          const result = yield* callOpenRouter(
            apiKey,
            payload.model ?? DEFAULT_MODEL,
            [...history, { role: "user", content: payload.message }],
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
          const userMessage = {
            role: "user" as const,
            content: payload.message,
          }

          // 1) Persist the user message immediately — survives a fast disconnect
          //    where no assistant tokens arrive before the client gives up.
          yield* agent.append([userMessage]).pipe(Effect.orDie)

          const buffer = yield* Ref.make("")
          const controller = new AbortController()

          const upstream = streamOpenRouter({
            apiKey,
            model: payload.model ?? DEFAULT_MODEL,
            messages: [...history, userMessage],
            signal: controller.signal,
          })

          const encodeStreamPart = Schema.encodeSync(StreamPart)

          // 2) Always abort the upstream fetch when this stream ends or is
          //    interrupted.
          const abortUpstream = Effect.sync(() => controller.abort())

          // 3) Persist whatever assistant text accumulated. Runs in finalizer
          //    on success AND on interrupt. Empty buffer = skip the assistant
          //    write.
          const persistAssistant = Effect.gen(function* () {
            const text = yield* Ref.get(buffer)
            if (text.length === 0) return
            yield* agent
              .append([{ role: "assistant", content: text }])
              .pipe(Effect.orDie)
          })

          const sseFrames = upstream.pipe(
            // Wire-level error → in-band StreamPartError so the FE's
            // Schema.decodeUnknownEffect(StreamPart) decoder accepts it.
            // `Stream.catch` is the v4 rename of `Stream.catchAll`.
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
            // `Effect.andThen` is the v4 replacement for `Effect.zipRight`.
            Stream.ensuring(Effect.andThen(abortUpstream, persistAssistant)),
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
