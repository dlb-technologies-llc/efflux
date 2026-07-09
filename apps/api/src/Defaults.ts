import type { ResolvedConfigType } from "@effect-flue/shared"
import { AgentConfig, DEFAULT_TOOL_RULES } from "@effect-flue/shared"

export const DEFAULT_MODEL = "tencent/hy3:free"

/** Placeholder session TTL (1 day) until the TTL reaper (#48) consumes it; config-as-data ahead of its consumer. */
export const DEFAULT_TTL_SECONDS = 86_400

/** Placeholder compaction token ceiling until context compaction (#47) consumes it; config-as-data ahead of its consumer. */
export const DEFAULT_COMPACTION_THRESHOLD = 100_000

/** Merge a session's stored partial overrides over the app defaults into the fully-populated effective config. */
export const resolveConfig = (stored: typeof AgentConfig.Type): ResolvedConfigType => ({
  defaultModel: stored.defaultModel ?? DEFAULT_MODEL,
  rules: { ...DEFAULT_TOOL_RULES, ...(stored.rules ?? {}) },
  ttlSeconds: stored.ttlSeconds ?? DEFAULT_TTL_SECONDS,
  compactionThreshold: stored.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD,
})
