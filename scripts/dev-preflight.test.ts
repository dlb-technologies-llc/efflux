import { describe, expect, it } from "@effect/vitest"
import { validateDevVars } from "./dev-preflight.ts"

describe("validateDevVars", () => {
  const good = "API_TOKEN=abc\nVITE_API_TOKEN=abc\nOPENROUTER_API_KEY=k\nSECRETS_ENCRYPTION_KEY=s\n"
  it("accepts a complete, consistent file", () => {
    expect(validateDevVars(good).errors).toEqual([])
  })
  it("flags a missing required key", () => {
    const r = validateDevVars("API_TOKEN=abc\nVITE_API_TOKEN=abc\nOPENROUTER_API_KEY=k\n")
    expect(r.errors.some((e) => e.includes("SECRETS_ENCRYPTION_KEY"))).toBe(true)
  })
  it("flags a duplicated key", () => {
    const r = validateDevVars(good + "SECRETS_ENCRYPTION_KEY=other\n")
    expect(r.errors.some((e) => e.includes("appears 2×"))).toBe(true)
  })
  it("flags VITE_API_TOKEN != API_TOKEN", () => {
    const r = validateDevVars("API_TOKEN=abc\nVITE_API_TOKEN=zzz\nOPENROUTER_API_KEY=k\nSECRETS_ENCRYPTION_KEY=s\n")
    expect(r.errors.some((e) => e.includes("must equal API_TOKEN"))).toBe(true)
  })
  it("rejects the placeholder OPENROUTER_API_KEY", () => {
    const r = validateDevVars("API_TOKEN=abc\nVITE_API_TOKEN=abc\nOPENROUTER_API_KEY=sk-or-your-key-here\nSECRETS_ENCRYPTION_KEY=s\n")
    expect(r.errors.some((e) => e.includes("placeholder"))).toBe(true)
  })
  it("ignores comments and blank lines", () => {
    expect(validateDevVars("# comment\n\n" + good).errors).toEqual([])
  })
})
