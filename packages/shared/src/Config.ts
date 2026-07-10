import { Schema } from "effect"
import { MODEL_ID_MAX_LENGTH, SafeName } from "./Schemas.ts"

/** Per-tool gate decision: `allow` runs the tool, `ask` parks the turn for approval, `deny` refuses outright. */
export const ToolRule = Schema.Literals(["allow", "ask", "deny"])

/** Map of tool name → gate decision; keys are bounded `SafeName`s so the rules table can't be probed with arbitrary strings. */
export const ToolRulesMap = Schema.Record(SafeName, ToolRule)

/** Decoded shape of `ToolRulesMap` — `{ readonly [name: string]: "allow" | "ask" | "deny" }`. */
export type RulesMap = typeof ToolRulesMap.Type

/** Canonical default rules table — Bash parks for approval, everything else falls through to `allow` via `resolveRule`. */
export const DEFAULT_TOOL_RULES: RulesMap = { Bash: "ask" }

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
