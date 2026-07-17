import { AgentConfig, DEFAULT_TOOL_RULES, type ResolvedConfig } from "@efflux/shared"
import { Effect, Schema } from "effect"
import type { AgentNamespace } from "./AgentStub.ts"

export const DEFAULT_MODEL = "tencent/hy3:free"

/** Fallback session idle-TTL (1 day) when a session stores no `ttlSeconds`: `Agent.#scheduleReap` slides the DO reaper alarm to `now + ttlSeconds` on every activity signal, and `alarm()` archives-and-purges the session when it fires — this governs how long an idle session survives before it is reaped. */
export const DEFAULT_TTL_SECONDS = 86_400

/** Fallback compaction token ceiling (100k) when a session stores no `compactionThreshold`: `Compaction.compactIfNeeded` reads it on every prompt/stream turn and summarizes older turns into a `compaction` event once the latest usage tokens exceed it — this governs when a session's context is compacted. */
export const DEFAULT_COMPACTION_THRESHOLD = 100_000

/** Default cumulative token ceiling per session — `null` = unlimited (opt-in). Set to a number to make every session default-capped; the cap is enforced pre-turn and mid-loop by the budget guard. */
export const DEFAULT_MAX_TOTAL_TOKENS: number | null = null

/** Default cumulative USD-cost ceiling per session — `null` = unlimited (opt-in). Cost is only reported by OpenRouter on paid keys; free models report none, so the token ceiling is the reliable floor. */
export const DEFAULT_MAX_COST_USD: number | null = null

/** Merge a session's stored partial overrides over the app defaults into the fully-populated effective config. */
export const resolveConfig = (stored: typeof AgentConfig.Type): ResolvedConfig => ({
  defaultModel: stored.defaultModel ?? DEFAULT_MODEL,
  rules: { ...DEFAULT_TOOL_RULES, ...(stored.rules ?? {}) },
  ttlSeconds: stored.ttlSeconds ?? DEFAULT_TTL_SECONDS,
  compactionThreshold: stored.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD,
  maxTotalTokens: stored.maxTotalTokens ?? DEFAULT_MAX_TOTAL_TOKENS,
  maxCostUsd: stored.maxCostUsd ?? DEFAULT_MAX_COST_USD,
  mcpServers: stored.mcpServers ?? [],
})

/** Load the session's stored overrides from the DO and resolve them against Defaults. Decode-dies on corruption (config was validated at PUT). */
export const loadResolvedConfig = (agent: ReturnType<AgentNamespace["getByName"]>) =>
  Effect.gen(function* () {
    const raw = yield* Effect.promise(() => agent.getConfig())
    const stored = yield* Schema.decodeUnknownEffect(AgentConfig)(raw).pipe(Effect.orDie)
    return resolveConfig(stored)
  })
