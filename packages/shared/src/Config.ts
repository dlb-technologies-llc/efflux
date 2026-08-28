import { Schema, Struct } from "effect"
import { MODEL_ID_MAX_LENGTH, SafeName } from "./Schemas.ts"

/** Per-tool gate decision: `allow` runs the tool, `ask` parks the turn for approval, `deny` refuses outright. */
export const ToolRule = Schema.Literals(["allow", "ask", "deny"])

/** Map of tool name → gate decision; keys are bounded `SafeName`s so the rules table can't be probed with arbitrary strings. */
export const ToolRulesMap = Schema.Record(SafeName, ToolRule)

/** Decoded shape of `ToolRulesMap` — `{ readonly [name: string]: "allow" | "ask" | "deny" }`. */
export type RulesMap = typeof ToolRulesMap.Type

/** Canonical default rules table — Bash, request_secret, create_scheduled_job, memory_write, and memory_delete all park for approval by default; everything else (including memory_read) falls through to `allow` via `resolveRule`. Routing request_secret/create_scheduled_job through this same policy table (rather than a hardcoded always-park) is what lets the `/v1` facade's `autoApproveRules` (ask→allow, since that facade can never resume a parked turn) treat them the same way it already treats Bash. memory_write/memory_delete park because they are durable side effects: a fetched page must not silently persist instructions into every future session's system prompt. */
export const DEFAULT_TOOL_RULES: RulesMap = {
  Bash: "ask",
  request_secret: "ask",
  create_scheduled_job: "ask",
  memory_write: "ask",
  memory_delete: "ask",
}

/** Resolve the gate decision for a tool; tools absent from the map default to `allow`. */
export const resolveRule = (
  rules: RulesMap,
  name: string,
): typeof ToolRule.Type => rules[name] ?? "allow"

/** One external MCP server the session may pull tools from. v1: public servers only, no auth headers (see #46 follow-up). */
export const McpServerConfig = Schema.Struct({
  name: SafeName,
  url: Schema.String.check(Schema.isMaxLength(2048)),
})

/** Decoded shape of `McpServerConfig`. */
export type McpServer = typeof McpServerConfig.Type

/** A cumulative token ceiling: a whole number of at least 1. Single source of the token-budget validation rule — shared by `AgentConfig`, `ResolvedConfig`, `SetBudgetRequest`, and the web Budget panel's field validation, so the "impossible value" definition can never drift between server and client. */
export const MaxTotalTokens = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

/** A cumulative USD-cost ceiling: strictly greater than 0. Single source of the cost-budget validation rule (see `MaxTotalTokens`). */
export const MaxCostUsd = Schema.Number.check(Schema.isGreaterThan(0))

/** Partial session config overrides; PUT replaces the stored overrides wholesale, unset fields fall back to Defaults. */
export const AgentConfig = Schema.Struct({
  defaultModel: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(MODEL_ID_MAX_LENGTH))),
  rules: Schema.optionalKey(ToolRulesMap),
  ttlSeconds: Schema.optionalKey(Schema.Number.check(Schema.isGreaterThanOrEqualTo(1))),
  compactionThreshold: Schema.optionalKey(
    Schema.Number.check(Schema.isGreaterThanOrEqualTo(1)),
  ),
  maxTotalTokens: Schema.optionalKey(MaxTotalTokens),
  maxCostUsd: Schema.optionalKey(MaxCostUsd),
  mcpServers: Schema.optionalKey(Schema.Array(McpServerConfig)),
  /** Gates the cross-session memory INJECTION (the system-prompt index block) only; the memory tools are governed by `rules`. */
  memoryEnabled: Schema.optionalKey(Schema.Boolean),
})

/** Effective session config after Defaults fallback — the GET/PUT `/config` response. `maxTotalTokens`/`maxCostUsd` are always present; `null` = unlimited (no cap). */
export const ResolvedConfig = Schema.Struct({
  defaultModel: Schema.String,
  rules: ToolRulesMap,
  ttlSeconds: Schema.Number,
  compactionThreshold: Schema.Number,
  maxTotalTokens: Schema.NullOr(MaxTotalTokens),
  maxCostUsd: Schema.NullOr(MaxCostUsd),
  mcpServers: Schema.Array(McpServerConfig),
  memoryEnabled: Schema.Boolean,
})

/** Decoded shape of the `ResolvedConfig` schema — the fully-populated effective session config. */
export type ResolvedConfig = typeof ResolvedConfig.Type

/** Payload for `PUT /agents/:name/:id/config/rules/:tool` — the single new gate decision for that tool. */
export const SetToolRuleRequest = Schema.Struct({
  rule: ToolRule,
})

/** Decoded shape of `SetToolRuleRequest`. */
export type SetToolRuleRequest = typeof SetToolRuleRequest.Type

/**
 * Merge one tool's gate decision into a session's stored config overrides,
 * preserving every other override field and every other rule. Pure — the
 * caller supplies an already-decoded `rule`; the merge never re-lists the
 * `ToolRule` literals so it cannot drift from the schema.
 */
export const mergeToolRule = (
  overrides: typeof AgentConfig.Type,
  tool: string,
  rule: typeof ToolRule.Type,
): typeof AgentConfig.Type => ({
  ...overrides,
  rules: { ...(overrides.rules ?? {}), [tool]: rule },
})

/** Payload for `PUT /agents/:name/:id/config/budget` — the session's token and cost ceilings. Each field is `null` to CLEAR that cap (inherit the default) or a value that must pass `MaxTotalTokens`/`MaxCostUsd`, so an impossible ceiling (zero, negative, fractional tokens) is rejected at decode on both the wire and the client. */
export const SetBudgetRequest = Schema.Struct({
  maxTotalTokens: Schema.NullOr(MaxTotalTokens),
  maxCostUsd: Schema.NullOr(MaxCostUsd),
})

/** Decoded shape of `SetBudgetRequest`. */
export type SetBudgetRequest = typeof SetBudgetRequest.Type

/**
 * Merge a budget change into a session's stored config overrides, preserving
 * every other override field. A `null` cap CLEARS that override key (the field
 * is inherit-to-default, never stored as `null`); a value replaces it. Pure —
 * the caller supplies an already-decoded budget, and `Struct.omit` drops the two
 * budget keys before re-adding only the set ones, so a clear never leaves a
 * stale value behind.
 */
export const mergeBudget = (
  overrides: typeof AgentConfig.Type,
  budget: SetBudgetRequest,
): typeof AgentConfig.Type => ({
  ...Struct.omit(overrides, ["maxTotalTokens", "maxCostUsd"]),
  ...(budget.maxTotalTokens !== null ? { maxTotalTokens: budget.maxTotalTokens } : {}),
  ...(budget.maxCostUsd !== null ? { maxCostUsd: budget.maxCostUsd } : {}),
})
