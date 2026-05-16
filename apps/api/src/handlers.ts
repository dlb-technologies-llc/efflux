import {
  AgentApi,
  HistoryResponse,
  Message,
  PromptResponse,
} from "@effect-flue/shared"
import * as Cloudflare from "alchemy/Cloudflare"
import { Context, Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import type Agent from "./Agent.ts"

export type AgentNamespace = Cloudflare.DurableObjectNamespace<Agent>

export class AgentStub extends Context.Service<AgentStub, AgentNamespace>()(
  "api/AgentStub",
) {}

export class OpenRouterApiKey extends Context.Service<
  OpenRouterApiKey,
  string
>()("api/OpenRouterApiKey") {}

const DEFAULT_MODEL = "anthropic/claude-sonnet-4-6"

const callOpenRouter = (
  apiKey: string,
  model: string,
  messages: ReadonlyArray<{ role: string; content: string }>,
) =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model, messages }),
      })
      const body = await res.text()
      if (!res.ok) {
        throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 500)}`)
      }
      const json = JSON.parse(body) as {
        choices: Array<{
          message: { content: string }
          finish_reason: string
        }>
        model: string
      }
      const choice = json.choices[0]
      if (!choice) {
        throw new Error(`OpenRouter returned no choices: ${body.slice(0, 500)}`)
      }
      return {
        text: choice.message.content,
        finishReason: choice.finish_reason,
        model: json.model,
      }
    },
    catch: (cause) =>
      cause instanceof Error
        ? cause
        : new Error(`OpenRouter call failed: ${String(cause)}`),
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
      .handle("stream", () =>
        Effect.die(new Error("stream handler not implemented yet")),
      ),
)
