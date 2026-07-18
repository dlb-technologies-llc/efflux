/**
 * Ground-truth pins for the pure filename sanitizer in `./upload.ts`.
 *
 * `toWorkspaceFilename` is the producer half of a producer -> consumer contract
 * with the backend's `WorkspaceFilename` schema (`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$`),
 * so every emitted string MUST match that pattern. Each pair below freezes the
 * EXACT output the sanitizer emits today (traced by hand from the transform), so
 * a future edit that changes the coercion breaks a pin instead of silently
 * drifting the upload path. The final case reasserts the contract regex over
 * every emitted output.
 *
 * @module
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { toWorkspaceFilename } from "./upload.ts"

const contract = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/

const cases: ReadonlyArray<readonly [string, string]> = [
  ["report.pdf", "report.pdf"],
  [".hidden", "hidden"],
  ["my report (final).pdf", "my_report__final_.pdf"],
  ["@@@", "file"],
  ["...", "file"],
  ["a".repeat(300), "a".repeat(255)],
]

describe("toWorkspaceFilename", () => {
  for (const [input, expected] of cases) {
    it.effect(`${JSON.stringify(input.slice(0, 32))} -> ${JSON.stringify(expected.slice(0, 32))}`, () =>
      Effect.sync(() => expect(toWorkspaceFilename(input)).toBe(expected)))
  }

  it.effect("300-char input caps at exactly 255", () =>
    Effect.sync(() => expect(toWorkspaceFilename("a".repeat(300)).length).toBe(255)))

  it.effect("every output satisfies the WorkspaceFilename contract", () =>
    Effect.sync(() => {
      for (const [input] of cases) {
        expect(toWorkspaceFilename(input)).toMatch(contract)
      }
    }))
})
