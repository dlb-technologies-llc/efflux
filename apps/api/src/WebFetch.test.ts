/**
 * Table tests for the web_fetch error surface and the prompt-cap boundary:
 * `causeMessage` renders the first fail/defect in a `Cause` as readable text,
 * `webFetchError` wraps a reason into the in-band status-0 result, and
 * `capForPrompt` clamps prompt-bound text at exactly {@link MAX_TOOL_OUTPUT_CHARS}.
 *
 * @module
 */
import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect } from "effect"
import { capForPrompt, MAX_TOOL_OUTPUT_CHARS } from "./Truncate.ts"
import { causeMessage, webFetchError } from "./WebFetch.ts"

interface CauseMessageCase {
  readonly label: string
  readonly cause: Cause.Cause<unknown>
  readonly expected: string
}

const causeMessageCases: ReadonlyArray<CauseMessageCase> = [
  {
    label: "fail(Error) → the error's message",
    cause: Cause.fail(new Error("x")),
    expected: "x",
  },
  {
    label: "die(string) → the defect stringified",
    cause: Cause.die("boom"),
    expected: "boom",
  },
  {
    label: "die(undefined) → unknown error",
    cause: Cause.die(undefined),
    expected: "unknown error",
  },
  {
    label: "empty cause → unknown error",
    cause: Cause.empty,
    expected: "unknown error",
  },
]

describe("causeMessage", () => {
  for (const { label, cause, expected } of causeMessageCases) {
    it.effect(label, () =>
      Effect.sync(() => expect(causeMessage(cause)).toBe(expected)))
  }
})

describe("webFetchError", () => {
  it.effect("wraps the reason as a status-0 in-band result", () =>
    Effect.sync(() =>
      expect(webFetchError("x")).toStrictEqual({
        status: 0,
        contentType: "",
        body: "Error: x",
        truncated: false,
      })))
})

describe("capForPrompt", () => {
  it.effect("MAX + 1 chars is truncated with a marker appended", () =>
    Effect.sync(() => {
      const body = "a".repeat(MAX_TOOL_OUTPUT_CHARS + 1)
      const result = capForPrompt(body)
      expect(result).toBe(
        `${"a".repeat(MAX_TOOL_OUTPUT_CHARS)}\n[output truncated]`,
      )
      expect(result).not.toBe(body)
      expect(result.endsWith("\n[output truncated]")).toBe(true)
    }))

  it.effect("exactly MAX chars is returned untouched", () =>
    Effect.sync(() => {
      const body = "a".repeat(MAX_TOOL_OUTPUT_CHARS)
      const result = capForPrompt(body)
      expect(result).toBe(body)
      expect(result.includes("[output truncated]")).toBe(false)
    }))
})
