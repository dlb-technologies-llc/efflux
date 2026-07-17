import {
  AgentApi,
  AgentConfig,
  ApprovalConflictError,
  ApprovalNotFoundError,
  BudgetExceededError,
  HistoryResponse,
  JournalEvent,
  JournalResponse,
  Message,
  PromptResponse,
  SessionInfo,
  SessionsResponse,
  SessionUsage,
  SubagentTaskResponse,
} from "@efflux/shared"
import { Effect, Schema } from "effect"
import { type LanguageModel, Prompt } from "effect/unstable/ai"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { composeMessages, loadOverlay } from "./AgentLoop.ts"
import { AgentStub } from "./AgentStub.ts"
import { budgetExceeded, capsFromConfig, type SpendTotals } from "./Budget.ts"
import { runAttachStream } from "./AttachStream.ts"
import { compactIfNeeded } from "./Compaction.ts"
import { loadResolvedConfig, resolveConfig } from "./Defaults.ts"
import { fetchAllEvents } from "./JournalRead.ts"
import { decodeEventPayload, openTurn } from "./JournalWrite.ts"
import { runPromptTurn } from "./PromptTurn.ts"
import type { KnowledgeSearch } from "./Knowledge.ts"
import { maxHopForTurn, type ReconstructEvent, reconstructForContinuation } from "./Reconstruct.ts"
import { RegistryStub } from "./Registry.ts"
import { buildSessionToolkit } from "./SessionToolkit.ts"
import type { SkillsBucket } from "./Skills.ts"
import { runStreamingTurn } from "./StreamingTurn.ts"
import { runSubagent } from "./Subagent.ts"
import { formatTodos } from "./Todo.ts"
import { WaitUntil } from "./WaitUntil.ts"

/** The turn's `user-message` snapshot (skill/role/model), narrowed, if present. */
const findUserMessage = (events: ReadonlyArray<ReconstructEvent>, turn: number) => {
  const row = events.find((e) => e.event._tag === "user-message" && e.seq === turn)
  return row !== undefined && row.event._tag === "user-message" ? row.event : undefined
}

export const AgentHandlers = HttpApiBuilder.group(AgentApi, "agents", (handlers) =>
  handlers
    .handle("prompt", ({ params, payload }) =>
      Effect.gen(function* () {
        const agents = yield* AgentStub
        const agent = agents.getByName(`${params.name}/${params.id}`)
        const resolved = yield* loadResolvedConfig(agent)
        const caps = capsFromConfig(resolved)
        const priorSpend: SpendTotals = yield* Effect.promise(() => agent.usageTotals())
        if (budgetExceeded(priorSpend, caps)) {
          return yield* new BudgetExceededError({
            message: "Session token/cost budget reached; raise the cap via PUT /config to continue.",
            totalTokens: priorSpend.tokens,
            totalCost: priorSpend.cost,
            maxTotalTokens: caps.maxTotalTokens,
            maxCostUsd: caps.maxCostUsd,
          })
        }
        const effectiveModel = payload.model ?? resolved.defaultModel
        yield* compactIfNeeded(agent, effectiveModel, resolved.compactionThreshold)
        const { toolkit, toolLayer } = yield* buildSessionToolkit(resolved.mcpServers)
        const todoItems = yield* Effect.promise(() => agent.latestTodos())
        const history = yield* Effect.promise(() => agent.history())
        const { skillBody, roleBody } = yield* loadOverlay(payload.skill, payload.role)
        const todos = todoItems.length > 0 ? formatTodos(todoItems) : undefined
        const messages = composeMessages({
          skillBody,
          roleBody,
          ...(todos !== undefined ? { todos } : {}),
          history,
          message: payload.message,
        })
        const turn = yield* openTurn(agent, payload)

        const result = yield* runPromptTurn({
          agent,
          turn,
          initialPrompt: Prompt.make(messages),
          model: effectiveModel,
          rules: resolved.rules,
          toolkit,
          toolLayer,
          caps,
          priorSpend,
        })

        const messageCount = history.length + (result.anyHopText ? 2 : 1)

        return new PromptResponse({
          text: result.finalText,
          finishReason: result.finalFinishReason,
          toolCallCount: result.toolCallCount,
          model: effectiveModel,
          messageCount,
          ...(result.approval !== undefined ? { approval: result.approval } : {}),
        })
      }),
    )
    .handle("history", ({ params }) =>
      Effect.gen(function* () {
        const agents = yield* AgentStub
        const agent = agents.getByName(`${params.name}/${params.id}`)
        const history = yield* Effect.promise(() => agent.history())
        return new HistoryResponse({
          history: history.map((m) => new Message({ role: m.role, content: m.content })),
        })
      }),
    )
    .handle("reset", ({ params, query }) =>
      Effect.gen(function* () {
        const agents = yield* AgentStub
        const agent = agents.getByName(`${params.name}/${params.id}`)
        const mode = query.mode ?? "reset"
        if (mode === "reset") {
          yield* Effect.promise(() => agent.reset())
        } else {
          yield* Effect.promise(() => agent.close({ mode, reason: "closed" }))
        }
      }),
    )
    .handle("journal", ({ params, query }) =>
      Effect.gen(function* () {
        const agents = yield* AgentStub
        const agent = agents.getByName(`${params.name}/${params.id}`)
        const after = query.after ?? 0
        const limit = Math.min(Math.max(query.limit ?? 100, 1), 500)
        const page = yield* Effect.promise(() => agent.readJournal({ after, limit }))
        const events = yield* Effect.forEach(page.events, (row) =>
          decodeEventPayload(JSON.parse(row.payload)).pipe(
            Effect.map((event) => new JournalEvent({ seq: row.seq, createdAt: row.createdAt, event })),
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
    .handle("usage", ({ params }) =>
      Effect.gen(function* () {
        const agents = yield* AgentStub
        const agent = agents.getByName(`${params.name}/${params.id}`)
        const resolved = yield* loadResolvedConfig(agent)
        const totals = yield* Effect.promise(() => agent.usageTotals())
        const caps = capsFromConfig(resolved)
        return new SessionUsage({
          totalTokens: totals.tokens,
          totalCost: totals.cost,
          maxTotalTokens: resolved.maxTotalTokens,
          maxCostUsd: resolved.maxCostUsd,
          exceeded: budgetExceeded(totals, caps),
        })
      }),
    )
    .handle("getConfig", ({ params }) =>
      Effect.gen(function* () {
        const agents = yield* AgentStub
        const agent = agents.getByName(`${params.name}/${params.id}`)
        return yield* loadResolvedConfig(agent)
      }),
    )
    .handle("putConfig", ({ params, payload }) =>
      Effect.gen(function* () {
        const agents = yield* AgentStub
        const agent = agents.getByName(`${params.name}/${params.id}`)
        yield* Effect.promise(() => agent.putConfig(Schema.encodeSync(AgentConfig)(payload)))
        return resolveConfig(payload)
      }),
    )
    .handle("putToolRule", ({ params, payload }) =>
      Effect.gen(function* () {
        const agents = yield* AgentStub
        const agent = agents.getByName(`${params.name}/${params.id}`)
        yield* Effect.promise(() => agent.setToolRule(params.tool, payload.rule))
        return yield* loadResolvedConfig(agent)
      }),
    )
    .handle("stream", ({ params, payload }) =>
      Effect.gen(function* () {
        const agents = yield* AgentStub
        const agent = agents.getByName(`${params.name}/${params.id}`)
        const waitUntil = yield* WaitUntil
        const ambient = yield* Effect.context<LanguageModel.LanguageModel | SkillsBucket | KnowledgeSearch>()
        const resolved = yield* loadResolvedConfig(agent)
        const caps = capsFromConfig(resolved)
        const priorSpend: SpendTotals = yield* Effect.promise(() => agent.usageTotals())
        const effectiveModel = payload.model ?? resolved.defaultModel
        yield* compactIfNeeded(agent, effectiveModel, resolved.compactionThreshold)
        const { toolkit, toolLayer } = yield* buildSessionToolkit(resolved.mcpServers)

        const todoItems = yield* Effect.promise(() => agent.latestTodos())
        const history = yield* Effect.promise(() => agent.history())
        const { skillBody, roleBody } = yield* loadOverlay(payload.skill, payload.role)
        const todos = todoItems.length > 0 ? formatTodos(todoItems) : undefined
        const messages = composeMessages({
          skillBody,
          roleBody,
          ...(todos !== undefined ? { todos } : {}),
          history,
          message: payload.message,
        })
        const turn = yield* openTurn(agent, payload)

        return yield* runStreamingTurn({
          agent,
          ambient,
          turn,
          startHop: 0,
          initialPrompt: Prompt.make(messages),
          model: effectiveModel,
          rules: resolved.rules,
          toolkit,
          toolLayer,
          waitUntil,
          caps,
          priorSpend,
        })
      }),
    )
    .handle("approve", ({ params, payload }) =>
      Effect.gen(function* () {
        const agents = yield* AgentStub
        const agent = agents.getByName(`${params.name}/${params.id}`)
        const waitUntil = yield* WaitUntil
        const ambient = yield* Effect.context<LanguageModel.LanguageModel | SkillsBucket | KnowledgeSearch>()
        const approved = payload.approved ?? true

        const res = yield* Effect.promise(async () =>
          agent.resolveApproval({
            eventId: params.eventId,
            approved,
            ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
          }),
        )
        if (res.status === "not-found") {
          return yield* new ApprovalNotFoundError({ eventId: params.eventId })
        }
        if (res.status !== "ok") {
          return yield* new ApprovalConflictError({ eventId: params.eventId, message: res.status })
        }

        const resolved = yield* loadResolvedConfig(agent)
        const caps = capsFromConfig(resolved)
        const priorSpend: SpendTotals = yield* Effect.promise(() => agent.usageTotals())
        const { toolkit, toolLayer } = yield* buildSessionToolkit(resolved.mcpServers)
        const events = yield* fetchAllEvents(agent)
        const userMsg = findUserMessage(events, res.turn)
        const { skillBody, roleBody } = yield* loadOverlay(userMsg?.skill, userMsg?.role)
        const effectiveModel = userMsg?.model ?? resolved.defaultModel
        const todoItems = yield* Effect.promise(() => agent.latestTodos())
        const todos = todoItems.length > 0 ? formatTodos(todoItems) : undefined

        const initialPrompt = reconstructForContinuation({
          events,
          parkedTurn: res.turn,
          approvalId: res.approvalId,
          approved,
          ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
          skillBody,
          roleBody,
          ...(todos !== undefined ? { todos } : {}),
        })

        return yield* runStreamingTurn({
          agent,
          ambient,
          turn: res.turn,
          startHop: maxHopForTurn(events, res.turn) + 1,
          initialPrompt,
          model: effectiveModel,
          rules: resolved.rules,
          toolkit,
          toolLayer,
          waitUntil,
          caps,
          priorSpend,
        })
      }),
    )
    .handle("attach", ({ params, headers, query }) =>
      Effect.gen(function* () {
        const agents = yield* AgentStub
        const agent = agents.getByName(`${params.name}/${params.id}`)
        const after = headers["last-event-id"] ?? query.after
        return runAttachStream({ agent, after })
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
