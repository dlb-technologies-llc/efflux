/**
 * Truth-table pins for the constant-time credential compare
 * (`constantTimeEquals`) that backs bearer auth.
 *
 * REGRESSION PIN: a length mismatch must NEVER short-circuit to a match. An
 * earlier length-guard `return` would have leaked, via timing, whether the
 * supplied credential was the right length before any byte comparison. The
 * `("", "x")` and `("x", "")` cases freeze that both directions of an
 * empty/non-empty length gap resolve to `false`, and the equal-length rows
 * confirm the byte-level compare still discriminates.
 *
 * @module
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { constantTimeEquals } from "./AuthMiddleware.ts"

const vectors: ReadonlyArray<readonly [string, string, boolean]> = [
  ["secret-token", "secret-token", true],
  ["secret-token", "secret-tokeX", false],
  ["secret", "secret-token", false],
  ["secret-token", "secret", false],
  ["", "secret-token", false],
  ["secret-token", "", false],
  ["", "", true],
  ["", "x", false],
  ["x", "", false],
]

describe("constantTimeEquals", () => {
  for (const [a, b, expected] of vectors) {
    it.effect(`${JSON.stringify(a)} vs ${JSON.stringify(b)} -> ${expected}`, () =>
      Effect.sync(() => expect(constantTimeEquals(a, b)).toBe(expected)))
  }
})
