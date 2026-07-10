/**
 * Ground-truth pins for the pure dotenv parser and bearer resolver exported by
 * `./devvars.ts` — the derivation that feeds the FE's build-time `API_TOKEN`.
 *
 * Hand-written vectors (a legitimate non-schema one-off; no schema backs this
 * flat `Record<string, string>`): they freeze `parseDotenv`'s blank/comment
 * skipping, first-`=` split, key/value trimming, quote-unwrapping, and inline
 * `#`-comment stripping (matching wrangler's dotenv), plus `resolveApiToken`'s
 * explicit-wins / `.dev.vars`-fallback / empty-string precedence, so a future
 * edit to either breaks a pin instead of drifting the `Bearer` the frontend ships with.
 *
 * @module
 */
import { describe, expect, it } from "@effect/vitest"
import { parseDotenv, resolveApiToken } from "./devvars.ts"

describe("parseDotenv", () => {
  it("parses KEY=value lines into a map", () => {
    expect(parseDotenv("A=1\nB=two")).toEqual({ A: "1", B: "two" })
  })

  it("skips blank lines and # comments", () => {
    expect(parseDotenv("# comment\n\nA=1\n")).toEqual({ A: "1" })
  })

  it("strips one surrounding pair of double or single quotes", () => {
    expect(parseDotenv("A=\"abc\"\nB='def'")).toEqual({ A: "abc", B: "def" })
  })

  it("skips lines with no =", () => {
    expect(parseDotenv("NOEQUALS\nA=1")).toEqual({ A: "1" })
  })

  it("trims whitespace around key and value", () => {
    expect(parseDotenv("  A =  1  ")).toEqual({ A: "1" })
  })

  it("truncates an unquoted value at an inline # comment", () => {
    expect(parseDotenv("A=abc # my token")).toEqual({ A: "abc" })
    expect(parseDotenv("A=abc#nospace")).toEqual({ A: "abc" })
  })

  it("discards a trailing comment after a closing quote", () => {
    expect(parseDotenv("A=\"ab c\" # note")).toEqual({ A: "ab c" })
  })

  it("keeps a # that lives inside a quoted value", () => {
    expect(parseDotenv("A=\"a#b\"")).toEqual({ A: "a#b" })
  })
})

describe("resolveApiToken", () => {
  it("prefers an explicit non-empty value over .dev.vars", () => {
    expect(resolveApiToken("explicit", { API_TOKEN: "fromvars" })).toBe("explicit")
  })

  it("falls back to .dev.vars API_TOKEN when explicit is empty or undefined", () => {
    expect(resolveApiToken("", { API_TOKEN: "fromvars" })).toBe("fromvars")
    expect(resolveApiToken(undefined, { API_TOKEN: "fromvars" })).toBe("fromvars")
  })

  it("returns empty string when neither source has a token", () => {
    expect(resolveApiToken(undefined, undefined)).toBe("")
    expect(resolveApiToken("", {})).toBe("")
  })
})
