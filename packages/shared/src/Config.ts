import { Schema } from "effect"
import { MODEL_ID_MAX_LENGTH, SafeName } from "./Schemas.ts"

/** Per-tool gate decision: `allow` runs the tool, `ask` parks the turn for approval, `deny` refuses outright. */
export const ToolRule = Schema.Literals(["allow", "ask", "deny"])

/** Map of tool name → gate decision; keys are bounded `SafeName`s so the rules table can't be probed with arbitrary strings. */
export const ToolRulesMap = Schema.Record(SafeName, ToolRule)

/** Decoded shape of `ToolRulesMap` — `{ readonly [name: string]: "allow" | "ask" | "deny" }`. */
export type RulesMap = typeof ToolRulesMap.Type

/** Canonical default rules table — Bash, request_secret, and create_scheduled_job all park for approval by default; everything else falls through to `allow` via `resolveRule`. Routing request_secret/create_scheduled_job through this same policy table (rather than a hardcoded always-park) is what lets the `/v1` facade's `autoApproveRules` (ask→allow, since that facade can never resume a parked turn) treat them the same way it already treats Bash. */
export const DEFAULT_TOOL_RULES: RulesMap = {
  Bash: "ask",
  request_secret: "ask",
  create_scheduled_job: "ask",
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

/** Partial session config overrides; PUT replaces the stored overrides wholesale, unset fields fall back to Defaults. */
export const AgentConfig = Schema.Struct({
  defaultModel: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(MODEL_ID_MAX_LENGTH))),
  rules: Schema.optionalKey(ToolRulesMap),
  ttlSeconds: Schema.optionalKey(Schema.Number.check(Schema.isGreaterThanOrEqualTo(1))),
  compactionThreshold: Schema.optionalKey(
    Schema.Number.check(Schema.isGreaterThanOrEqualTo(1)),
  ),
  mcpServers: Schema.optionalKey(Schema.Array(McpServerConfig)),
})

/** Effective session config after Defaults fallback — the GET/PUT `/config` response. */
export const ResolvedConfig = Schema.Struct({
  defaultModel: Schema.String,
  rules: ToolRulesMap,
  ttlSeconds: Schema.Number,
  compactionThreshold: Schema.Number,
  mcpServers: Schema.Array(McpServerConfig),
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
