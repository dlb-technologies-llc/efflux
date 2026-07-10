/**
 * Characterization round-trips for the SSE + session-config contract schemas,
 * pinning today's encode/decode behaviour so later schema edits stay green.
 *
 * Three groups:
 *
 * 1. `StreamPart` — the SSE frame union — is exercised with a
 *    `Schema.toArbitrary` generator: every value the union admits must survive
 *    encode → decode → re-encode with a stable encoded form. No member carries a
 *    regex-refined field, so the generator needs no pins (`params`/`result` are
 *    `Schema.Unknown`, an identity codec).
 *
 * 2. Config schemas. `ToolRule` is codec-clean (a `Schema.Literals`) and gets
 *    the same property round-trip. `ResolvedConfig` and `AgentConfig` reach the
 *    `SafeName` refinement transitively (via `ToolRulesMap` keys and
 *    `McpServerConfig.name`); `Schema.toArbitrary` on that regex-refined shape
 *    exhausts the FastCheck filter, so they are pinned with fixed representative
 *    values instead.
 *
 * 3. SSE symmetry is intentionally NOT asserted: `Sse.ts` exposes only
 *    `streamAgentSse`, a decode-side `Stream` helper wrapping
 *    `effect/unstable/encoding/Sse`. It offers no pure encode-line/decode-line
 *    pair to round-trip, so the per-tag SSE symmetry check is skipped.
 *
 * @module
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import {
  AgentConfig,
  ResolvedConfig,
  StreamPart,
  ToolRule,
} from "@efflux/shared"

const streamPartArb = Schema.toArbitrary(StreamPart)

describe("StreamPart codec", () => {
  it.effect.prop(
    "encode → decode → re-encode is stable",
    [streamPartArb],
    ([part]) =>
      Effect.gen(function* () {
        const encoded = yield* Schema.encodeEffect(StreamPart)(part)
        const decoded = yield* Schema.decodeEffect(StreamPart)(encoded)
        const reEncoded = yield* Schema.encodeEffect(StreamPart)(decoded)
        expect(reEncoded).toStrictEqual(encoded)
      }),
    { fastCheck: { numRuns: 100 } },
  )
})

const toolRuleArb = Schema.toArbitrary(ToolRule)

describe("ToolRule codec", () => {
  it.effect.prop(
    "encode → decode → re-encode is stable",
    [toolRuleArb],
    ([rule]) =>
      Effect.gen(function* () {
        const encoded = yield* Schema.encodeEffect(ToolRule)(rule)
        const decoded = yield* Schema.decodeEffect(ToolRule)(encoded)
        const reEncoded = yield* Schema.encodeEffect(ToolRule)(decoded)
        expect(reEncoded).toStrictEqual(encoded)
      }),
    { fastCheck: { numRuns: 100 } },
  )
})

const resolvedConfigPins: ReadonlyArray<ResolvedConfig> = [
  {
    defaultModel: "tencent/hy3:free",
    rules: {},
    ttlSeconds: 1,
    compactionThreshold: 1,
    mcpServers: [],
  },
  {
    defaultModel: "openai/gpt-4o-mini",
    rules: { Bash: "ask", Read: "allow", Write: "deny" },
    ttlSeconds: 3600,
    compactionThreshold: 50,
    mcpServers: [{ name: "context7", url: "https://mcp.example.com/sse" }],
  },
]

describe("ResolvedConfig codec", () => {
  resolvedConfigPins.forEach((config, index) => {
    it.effect(`pin ${index} round-trips`, () =>
      Effect.gen(function* () {
        const encoded = yield* Schema.encodeEffect(ResolvedConfig)(config)
        const decoded = yield* Schema.decodeEffect(ResolvedConfig)(encoded)
        const reEncoded = yield* Schema.encodeEffect(ResolvedConfig)(decoded)
        expect(decoded).toStrictEqual(config)
        expect(reEncoded).toStrictEqual(encoded)
      }))
  })
})

const agentConfigPins: ReadonlyArray<typeof AgentConfig.Type> = [
  {},
  { rules: { Bash: "ask" } },
  {
    defaultModel: "openai/gpt-4o-mini",
    rules: { Bash: "ask", Read: "allow", Write: "deny" },
    ttlSeconds: 7200,
    compactionThreshold: 100,
    mcpServers: [{ name: "docs-server", url: "https://mcp.example.com/sse" }],
  },
]

describe("AgentConfig codec", () => {
  agentConfigPins.forEach((config, index) => {
    it.effect(`pin ${index} round-trips`, () =>
      Effect.gen(function* () {
        const encoded = yield* Schema.encodeEffect(AgentConfig)(config)
        const decoded = yield* Schema.decodeEffect(AgentConfig)(encoded)
        const reEncoded = yield* Schema.encodeEffect(AgentConfig)(decoded)
        expect(decoded).toStrictEqual(config)
        expect(reEncoded).toStrictEqual(encoded)
      }))
  })
})
