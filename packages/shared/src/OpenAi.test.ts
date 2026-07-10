/**
 * Round-trip + negative characterization for the `/v1` OpenAI-facade session
 * router — `OpenAi.parseAgentModel` / `formatAgentModel`.
 *
 * The positive law is a property: for any two `SafeId`s `n`, `i`,
 * `parseAgentModel(formatAgentModel(n, i))` recovers `{ name: n, id: i }`. Both
 * segments are validated through `SafeId`, a regex refinement whose
 * `Schema.toArbitrary` generator exhausts the FastCheck `.filter`; the property
 * is therefore driven over a curated set of valid `SafeId` representatives —
 * ASCII letters/digits/`-`/`_`, never `:`, the segment delimiter.
 *
 * The negative table pins the shapes `parseAgentModel` must reject as
 * `undefined`: a plain model name, wrong segment counts, a non-`agent` prefix,
 * and empty segments that fail the `SafeId` decode.
 *
 * @module
 */
import { describe, expect, it } from "@effect/vitest"
import { formatAgentModel, parseAgentModel } from "@efflux/shared"
import { FastCheck } from "effect/testing"

const safeIds: ReadonlyArray<string> = [
  "a",
  "agent",
  "foo-bar",
  "foo_bar",
  "A1b2",
  "123",
  "session-01_test",
  "z".repeat(128),
]

const safeIdArb = FastCheck.constantFrom(...safeIds)

const rejected: ReadonlyArray<string> = [
  "gpt-4o",
  "agent:only",
  "agent:a:b:c",
  "agent::",
  "model:a:b",
]

describe("parseAgentModel / formatAgentModel", () => {
  it.prop(
    "round-trips any two SafeIds through the agent model id",
    [safeIdArb, safeIdArb],
    ([name, id]) => {
      expect(parseAgentModel(formatAgentModel(name, id))).toStrictEqual({ name, id })
    },
    { fastCheck: { numRuns: 100 } },
  )

  rejected.forEach((model) => {
    it(`rejects ${JSON.stringify(model)} as undefined`, () => {
      expect(parseAgentModel(model)).toBeUndefined()
    })
  })
})
