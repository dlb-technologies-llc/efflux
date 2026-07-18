import {
  AgentApi,
  ChatCompletionChoice,
  ChatCompletionResponse,
  ChatCompletionUsage,
  type ChatMessage,
  formatAgentModel,
  ModelObject,
  ModelsResponse,
  parseAgentModel,
  type RulesMap,
  type ToolRule,
} from "@efflux/shared"
import { Effect, Schema } from "effect"
import { type LanguageModel, Prompt } from "effect/unstable/ai"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { loadOverlay } from "./AgentLoop.ts"
import { AgentStub } from "./AgentStub.ts"
import { budgetExceeded, capsFromConfig, type SpendTotals } from "./Budget.ts"
import { loadResolvedConfig } from "./Defaults.ts"
import { openTurn } from "./JournalWrite.ts"
import type { KnowledgeSearch } from "./Knowledge.ts"
import { loadMemoryIndex } from "./Memory.ts"
import { collectOpenAiTurn, streamOpenAiTurn } from "./OpenAiTurn.ts"
import { RegistryStub } from "./Registry.ts"
import { buildSessionToolkit } from "./SessionToolkit.ts"
import type { SkillsBucket } from "./Skills.ts"

/**
 * Tools whose side effect is DURABLE and CROSS-SESSION (a memory write lands in
 * every future session's system prompt for that agent name). On this facade —
 * which can never park a turn for approval — their `ask` fails CLOSED to `deny`
 * instead of open to `allow`: auto-allowing them would let a prompt-injected
 * conversation silently persist instructions across sessions, the exact outcome
 * the `DEFAULT_TOOL_RULES` `ask` defaults exist to prevent. A session that
 * wants unattended facade writes sets the rule to `allow` explicitly.
 */
const FACADE_FAIL_CLOSED_TOOLS: ReadonlySet<string> = new Set(["memory_write", "memory_delete"])

/** Map a session's resolved rules for the facade: `ask` → `allow` (OpenAI cannot approve) for session-scoped tools, but `ask` → `deny` for the durable cross-session tools in {@link FACADE_FAIL_CLOSED_TOOLS}; `deny`/`allow` preserved. */
const autoApproveRules = (rules: RulesMap): RulesMap =>
  Object.fromEntries(
    Object.entries(rules).map(
      ([name, rule]): [string, typeof ToolRule.Type] => [
        name,
        rule === "ask" ? (FACADE_FAIL_CLOSED_TOOLS.has(name) ? "deny" : "allow") : rule,
      ],
    ),
  )

/** OpenAI-shaped 400 for a malformed `model` field or a request with no user message; `code` distinguishes the two. */
const invalidRequest = (message: string, code: string): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe(
    { error: { message, type: "invalid_request_error", code } },
    { status: 400 },
  )

/** OpenAI-shaped 402 when the session has reached its budget. */
const budgetExceededResponse = (message: string): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe(
    { error: { message, type: "insufficient_quota", code: "budget_exceeded" } },
    { status: 402 },
  )

/** Map an OpenAI message list to a facade prompt: default `support` skill as the system message, an optional cross-session memory index as a second system message, then the client's user/assistant turns verbatim; system/tool/`content:null` messages are dropped. */
const toPromptMessages = (
  skillBody: string,
  messages: ReadonlyArray<ChatMessage>,
  memory?: string,
): ReadonlyArray<{ role: "system" | "user" | "assistant"; content: string }> => {
  const systemMessages: Array<{ role: "system"; content: string }> = [
    { role: "system", content: skillBody },
  ]
  if (memory !== undefined) systemMessages.push({ role: "system", content: memory })
  return [
    ...systemMessages,
    ...messages.flatMap((m) =>
      (m.role === "user" || m.role === "assistant") && m.content !== null
        ? [{ role: m.role, content: m.content }]
        : [],
    ),
  ]
}

/** OpenAI-compatible facade handlers for the `v1` group: chat completions (JSON or SSE) and the session-backed model list. */
export const OpenAiHandlers = HttpApiBuilder.group(AgentApi, "v1", (handlers) =>
  handlers
    .handle("chatCompletions", ({ payload }) =>
      Effect.gen(function* () {
        const parsed = parseAgentModel(payload.model)
        if (parsed === undefined) {
          return invalidRequest(`Unknown model '${payload.model}'. Use 'agent:<name>:<id>'.`, "model_not_found")
        }

        const agents = yield* AgentStub
        const agent = agents.getByName(`${parsed.name}/${parsed.id}`)
        const resolved = yield* loadResolvedConfig(agent)
        const caps = capsFromConfig(resolved)
        const priorSpend: SpendTotals = yield* Effect.promise(() => agent.usageTotals())
        if (budgetExceeded(priorSpend, caps)) {
          return budgetExceededResponse("Session token/cost budget reached; raise the cap via PUT /config to continue.")
        }
        const { toolkit, toolLayer } = yield* buildSessionToolkit(resolved.mcpServers)

        const { skillBody } = yield* loadOverlay(undefined, undefined)
        const memory = yield* loadMemoryIndex(parsed.name, resolved.memoryEnabled)
        const promptMessages = toPromptMessages(skillBody, payload.messages, memory)

        const lastUser = [...payload.messages]
          .reverse()
          .find((m) => m.role === "user" && m.content !== null)
        if (lastUser === undefined || lastUser.content === null) {
          return invalidRequest("messages must contain a user message", "invalid_request")
        }
        const effectiveModel = resolved.defaultModel
        const turn = yield* openTurn(agent, { message: lastUser.content, model: effectiveModel })

        const meta = {
          id: `chatcmpl-${crypto.randomUUID()}`,
          created: Math.floor(Date.now() / 1000),
          model: payload.model,
        }
        const rules = autoApproveRules(resolved.rules)
        const initialPrompt = Prompt.make(promptMessages)

        if (payload.stream === true) {
          const ambient = yield* Effect.context<LanguageModel.LanguageModel | SkillsBucket | KnowledgeSearch>()
          return streamOpenAiTurn({
            agent,
            sessionId: `${parsed.name}/${parsed.id}`,
            ambient,
            turn,
            initialPrompt,
            model: effectiveModel,
            rules,
            meta,
            toolkit,
            toolLayer,
            caps,
            priorSpend,
          })
        }

        const collected = yield* collectOpenAiTurn({
          agent,
          sessionId: `${parsed.name}/${parsed.id}`,
          turn,
          initialPrompt,
          model: effectiveModel,
          rules,
          meta,
          toolkit,
          toolLayer,
          caps,
          priorSpend,
        })
        return HttpServerResponse.jsonUnsafe(
          Schema.encodeSync(ChatCompletionResponse)(
            new ChatCompletionResponse({
              id: meta.id,
              object: "chat.completion",
              created: meta.created,
              model: payload.model,
              choices: [
                new ChatCompletionChoice({
                  index: 0,
                  message: { role: "assistant", content: collected.text },
                  finish_reason: "stop",
                }),
              ],
              usage: new ChatCompletionUsage({
                prompt_tokens: collected.lastInputTokens,
                completion_tokens: collected.totalOutputTokens,
                total_tokens: collected.lastInputTokens + collected.totalOutputTokens,
              }),
            }),
          ),
        )
      }),
    )
    .handle("listModels", () =>
      Effect.gen(function* () {
        const registry = yield* RegistryStub
        const stub = registry.get(registry.idFromName("global"))
        const rows = yield* Effect.promise(() => stub.list())
        return new ModelsResponse({
          object: "list",
          data: rows.map(
            (row) =>
              new ModelObject({
                id: formatAgentModel(row.name, row.id),
                object: "model",
                created: row.createdAt,
                owned_by: "efflux",
              }),
          ),
        })
      }),
    ),
)
