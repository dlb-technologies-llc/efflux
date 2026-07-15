/**
 * Behaviour lock for `resolveRule`, the security-load-bearing allow/ask/deny
 * gate. Two groups:
 *
 * 1. Unit pins for the fallback semantics — an absent tool resolves to `allow`,
 *    every explicit rule is returned verbatim, and the canonical
 *    `DEFAULT_TOOL_RULES` table parks `Bash` on `ask` while any other tool
 *    falls through to `allow`.
 *
 * 2. A property covering the fallback's range: over rules maps built from fixed
 *    `SafeName` keys and `Schema.toArbitrary(ToolRule)` values, `resolveRule`
 *    never yields anything outside `ToolRule` — present or absent key alike, its
 *    output always decodes as `ToolRule`. `ToolRulesMap` keys are regex-refined
 *    `SafeName`s, so the keys are pinned (`Bash`/`web_fetch`/`Read`) rather than
 *    generated; only the rule values are drawn from the arbitrary.
 *
 * @module
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { DEFAULT_TOOL_RULES, mergeToolRule, resolveRule, SetToolRuleRequest, ToolRule } from "@efflux/shared"
import type { RulesMap } from "@efflux/shared"

const explicitRules: RulesMap = { Bash: "allow", web_fetch: "ask", Read: "deny" }

describe("resolveRule fallback semantics", () => {
  it("absent key falls through to allow", () => {
    expect(resolveRule({}, "Bash")).toBe("allow")
    expect(resolveRule(explicitRules, "Write")).toBe("allow")
  })

  it("each explicit rule is returned verbatim", () => {
    expect(resolveRule(explicitRules, "Bash")).toBe("allow")
    expect(resolveRule(explicitRules, "web_fetch")).toBe("ask")
    expect(resolveRule(explicitRules, "Read")).toBe("deny")
  })

  it("DEFAULT_TOOL_RULES parks Bash on ask", () => {
    expect(resolveRule(DEFAULT_TOOL_RULES, "Bash")).toBe("ask")
  })

  it("DEFAULT_TOOL_RULES lets any non-Bash tool fall through to allow", () => {
    expect(resolveRule(DEFAULT_TOOL_RULES, "Read")).toBe("allow")
  })
})

const setToolRuleArb = Schema.toArbitrary(SetToolRuleRequest)

describe("SetToolRuleRequest codec", () => {
  it.effect.prop(
    "encode → decode → re-encode is stable",
    [setToolRuleArb],
    ([request]) =>
      Effect.gen(function* () {
        const encoded = yield* Schema.encodeEffect(SetToolRuleRequest)(request)
        const decoded = yield* Schema.decodeEffect(SetToolRuleRequest)(encoded)
        const reEncoded = yield* Schema.encodeEffect(SetToolRuleRequest)(decoded)
        expect(reEncoded).toStrictEqual(encoded)
      }),
    { fastCheck: { numRuns: 100 } },
  )
})

describe("mergeToolRule", () => {
  it("merges one tool's rule into empty overrides", () => {
    expect(mergeToolRule({}, "Bash", "allow")).toStrictEqual({
      rules: { Bash: "allow" },
    })
  })

  it("overwrites an existing rule for the same tool", () => {
    expect(mergeToolRule({ rules: { Bash: "ask" } }, "Bash", "allow")).toStrictEqual({
      rules: { Bash: "allow" },
    })
  })

  it("preserves sibling rules untouched", () => {
    expect(mergeToolRule({ rules: { request_secret: "ask" } }, "Bash", "allow")).toStrictEqual({
      rules: { request_secret: "ask", Bash: "allow" },
    })
  })

  it("preserves other override fields", () => {
    expect(mergeToolRule({ defaultModel: "x/y", ttlSeconds: 42 }, "Bash", "allow")).toStrictEqual({
      defaultModel: "x/y",
      ttlSeconds: 42,
      rules: { Bash: "allow" },
    })
  })
})

const toolRuleArb = Schema.toArbitrary(ToolRule)
const decodeToolRule = Schema.decodeUnknownEffect(ToolRule)

describe("resolveRule range", () => {
  it.effect.prop(
    "output always decodes as ToolRule",
    [toolRuleArb, toolRuleArb, toolRuleArb],
    ([bash, webFetch, read]) =>
      Effect.gen(function* () {
        const rules: RulesMap = { Bash: bash, web_fetch: webFetch, Read: read }
        const lookups = ["Bash", "web_fetch", "Read", "absent_tool"]
        for (const name of lookups) {
          const rule = resolveRule(rules, name)
          const decoded = yield* decodeToolRule(rule)
          expect(decoded).toBe(rule)
        }
      }),
    { fastCheck: { numRuns: 100 } },
  )
})
