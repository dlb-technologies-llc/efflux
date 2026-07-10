/**
 * Vectors for the pure {@link validateDevVars} deploy-preflight validator exported by
 * `./preflight-env.ts`.
 *
 * The inputs are plain `Record<string, string>` config maps (no schema backs them — a
 * legitimate non-schema one-off), so the six cases are hand-written literals that pin
 * the validator's contract: `undefined` vars yield exactly one `.dev.vars` problem, a
 * missing/empty `OPENROUTER_API_KEY` names that var, the `.dev.vars.example` placeholder
 * key is called out as a `placeholder`, a missing/empty `API_TOKEN` names that var, and
 * complete real vars produce no problems at all.
 *
 * @module
 */
import { describe, expect, it } from "@effect/vitest"
import { PLACEHOLDER_OPENROUTER_KEY, validateDevVars } from "./preflight-env.ts"

describe("validateDevVars", () => {
  it("returns no problems for complete real vars", () => {
    expect(validateDevVars({ OPENROUTER_API_KEY: "sk-or-real-key", API_TOKEN: "tok" })).toEqual([])
  })

  it("reports a single problem when .dev.vars is absent", () => {
    const problems = validateDevVars(undefined)
    expect(problems).toHaveLength(1)
    expect(problems.some((p) => p.includes(".dev.vars"))).toBe(true)
  })

  it("reports a missing OPENROUTER_API_KEY", () => {
    expect(validateDevVars({ API_TOKEN: "tok" }).some((p) => p.includes("OPENROUTER_API_KEY"))).toBe(true)
  })

  it("reports the placeholder OPENROUTER_API_KEY", () => {
    const problems = validateDevVars({ OPENROUTER_API_KEY: PLACEHOLDER_OPENROUTER_KEY, API_TOKEN: "tok" })
    expect(problems.some((p) => p.includes("placeholder"))).toBe(true)
  })

  it("reports a missing API_TOKEN", () => {
    expect(validateDevVars({ OPENROUTER_API_KEY: "sk-or-real-key" }).some((p) => p.includes("API_TOKEN"))).toBe(true)
  })

  it("reports both required vars when both are absent", () => {
    expect(validateDevVars({})).toHaveLength(2)
  })
})
