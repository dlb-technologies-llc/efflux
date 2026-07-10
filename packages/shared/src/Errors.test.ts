/**
 * Table tests for the error-surfacing helpers: `messageOf` extracts a
 * best-effort string from any error-channel value, and `failureMessage` pulls
 * the first `Cause` failure's message (or a fallback for defect-only causes).
 * These give tui + web a uniform way to render errors.
 *
 * @module
 */
import { describe, expect, it } from "@effect/vitest"
import { Cause } from "effect"
import { AgentError, failureMessage, messageOf } from "@efflux/shared"

interface MessageOfCase {
  readonly label: string
  readonly input: unknown
  readonly expected: string
}

const messageOfCases: ReadonlyArray<MessageOfCase> = [
  { label: "object with string message", input: { message: "x" }, expected: "x" },
  { label: "Error instance", input: new Error("y"), expected: "y" },
  { label: "bare string", input: "z", expected: "z" },
  { label: "null", input: null, expected: "null" },
  {
    label: "object with non-string message",
    input: { message: 42 },
    expected: "[object Object]",
  },
]

describe("messageOf", () => {
  messageOfCases.forEach(({ label, input, expected }) => {
    it(`${label} → ${JSON.stringify(expected)}`, () => {
      expect(messageOf(input)).toBe(expected)
    })
  })
})

describe("failureMessage", () => {
  it("returns the first failure's message", () => {
    const cause = Cause.fail(new AgentError({ message: "boom" }))
    expect(failureMessage(cause, "fallback")).toBe("boom")
  })

  it("returns the fallback for a defect-only cause", () => {
    const cause = Cause.die("x")
    expect(failureMessage(cause, "fallback")).toBe("fallback")
  })
})
