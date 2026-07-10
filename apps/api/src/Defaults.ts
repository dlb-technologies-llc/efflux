import { AgentConfig, DEFAULT_TOOL_RULES, type ResolvedConfig } from "@efflux/shared"
import { Effect, Schema } from "effect"
import type { AgentNamespace } from "./AgentStub.ts"

export const DEFAULT_MODEL = "tencent/hy3:free"

/** Placeholder session TTL (1 day) until the TTL reaper (#48) consumes it; config-as-data ahead of its consumer. */
export const DEFAULT_TTL_SECONDS = 86_400

/** Placeholder compaction token ceiling until context compaction (#47) consumes it; config-as-data ahead of its consumer. */
export const DEFAULT_COMPACTION_THRESHOLD = 100_000

/** Merge a session's stored partial overrides over the app defaults into the fully-populated effective config. */
export const resolveConfig = (stored: typeof AgentConfig.Type): ResolvedConfig => ({
  defaultModel: stored.defaultModel ?? DEFAULT_MODEL,
  rules: { ...DEFAULT_TOOL_RULES, ...(stored.rules ?? {}) },
  ttlSeconds: stored.ttlSeconds ?? DEFAULT_TTL_SECONDS,
  compactionThreshold: stored.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD,
  mcpServers: stored.mcpServers ?? [],
})

/** Load the session's stored overrides from the DO and resolve them against Defaults. Decode-dies on corruption (config was validated at PUT). */
export const loadResolvedConfig = (agent: ReturnType<AgentNamespace["getByName"]>) =>
  Effect.gen(function* () {
    const raw = yield* Effect.promise(() => agent.getConfig())
    const stored = yield* Schema.decodeUnknownEffect(AgentConfig)(raw).pipe(Effect.orDie)
    return resolveConfig(stored)
  })
