/**
 * Characterization pins for the hop-capped tool loop's shared pure helpers
 * (`shouldContinueToolLoop`, `composeMessages`, `MAX_TOOL_HOPS`) in
 * `AgentLoop.ts`. These freeze the CURRENT behavior so a later dedup of the
 * two loop drivers cannot silently drift the hop-decision policy, the message
 * ordering, or the hop cap.
 *
 * The finish-reason table is enumerated from the canonical `FinishReason`
 * schema (`AiResponse.FinishReason.literals`) rather than re-listed, so a new
 * finish reason added upstream is automatically covered here.
 *
 * @module
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { Response as AiResponse } from "effect/unstable/ai"
import { composeMessages, MAX_TOOL_HOPS, shouldContinueToolLoop } from "./AgentLoop.ts"

describe("shouldContinueToolLoop", () => {
  for (const reason of AiResponse.FinishReason.literals) {
    const expected = reason === "tool-calls"
    it.effect(`${JSON.stringify(reason)} -> ${expected}`, () =>
      Effect.sync(() => expect(shouldContinueToolLoop(reason)).toBe(expected)))
  }

  it.effect("continues for exactly one finish reason (\"tool-calls\")", () =>
    Effect.sync(() => {
      const continuing = AiResponse.FinishReason.literals.filter(shouldContinueToolLoop)
      expect(continuing).toStrictEqual(["tool-calls"])
    }))
})

const composeCases: ReadonlyArray<{
  readonly name: string
  readonly input: Parameters<typeof composeMessages>[0]
  readonly expected: ReturnType<typeof composeMessages>
}> = [
  {
    name: "role present: [system(skill), system(role), ...history, user]",
    input: {
      skillBody: "SKILL",
      roleBody: "ROLE",
      history: [
        { role: "user", content: "h1" },
        { role: "assistant", content: "h2" },
      ],
      message: "MSG",
    },
    expected: [
      { role: "system", content: "SKILL" },
      { role: "system", content: "ROLE" },
      { role: "user", content: "h1" },
      { role: "assistant", content: "h2" },
      { role: "user", content: "MSG" },
    ],
  },
  {
    name: "role absent, empty history: [system(skill), user]",
    input: {
      skillBody: "SKILL",
      roleBody: undefined,
      history: [],
      message: "MSG",
    },
    expected: [
      { role: "system", content: "SKILL" },
      { role: "user", content: "MSG" },
    ],
  },
  {
    name: "role absent, with history: [system(skill), ...history, user]",
    input: {
      skillBody: "SKILL",
      roleBody: undefined,
      history: [
        { role: "user", content: "h1" },
        { role: "assistant", content: "h2" },
      ],
      message: "MSG",
    },
    expected: [
      { role: "system", content: "SKILL" },
      { role: "user", content: "h1" },
      { role: "assistant", content: "h2" },
      { role: "user", content: "MSG" },
    ],
  },
  {
    name: "role present, empty history: [system(skill), system(role), user]",
    input: {
      skillBody: "SKILL",
      roleBody: "ROLE",
      history: [],
      message: "MSG",
    },
    expected: [
      { role: "system", content: "SKILL" },
      { role: "system", content: "ROLE" },
      { role: "user", content: "MSG" },
    ],
  },
  {
    name: "todos present: [system(skill), system(role), system(todos), ...history, user]",
    input: {
      skillBody: "SKILL",
      roleBody: "ROLE",
      todos: "- [ ] a",
      history: [
        { role: "user", content: "h1" },
        { role: "assistant", content: "h2" },
      ],
      message: "MSG",
    },
    expected: [
      { role: "system", content: "SKILL" },
      { role: "system", content: "ROLE" },
      { role: "system", content: "Current task list:\n- [ ] a" },
      { role: "user", content: "h1" },
      { role: "assistant", content: "h2" },
      { role: "user", content: "MSG" },
    ],
  },
  {
    name: "todos absent (redundant safety): [system(skill), system(role), ...history, user]",
    input: {
      skillBody: "SKILL",
      roleBody: "ROLE",
      history: [
        { role: "user", content: "h1" },
        { role: "assistant", content: "h2" },
      ],
      message: "MSG",
    },
    expected: [
      { role: "system", content: "SKILL" },
      { role: "system", content: "ROLE" },
      { role: "user", content: "h1" },
      { role: "assistant", content: "h2" },
      { role: "user", content: "MSG" },
    ],
  },
  {
    name: "history skill is stripped from the model payload (projected to role+content)",
    input: {
      skillBody: "SKILL",
      roleBody: undefined,
      history: [
        { role: "user", content: "h1", skill: "brainstorm" },
        { role: "assistant", content: "h2" },
      ],
      message: "MSG",
    },
    expected: [
      { role: "system", content: "SKILL" },
      { role: "user", content: "h1" },
      { role: "assistant", content: "h2" },
      { role: "user", content: "MSG" },
    ],
  },
]

describe("composeMessages", () => {
  for (const testCase of composeCases) {
    it.effect(testCase.name, () =>
      Effect.sync(() =>
        expect(composeMessages(testCase.input)).toStrictEqual(testCase.expected)))
  }
})

describe("MAX_TOOL_HOPS", () => {
  it.effect("is 8", () => Effect.sync(() => expect(MAX_TOOL_HOPS).toBe(8)))

  it.effect("is a positive integer", () =>
    Effect.sync(() => {
      expect(Number.isInteger(MAX_TOOL_HOPS)).toBe(true)
      expect(MAX_TOOL_HOPS).toBeGreaterThan(0)
    }))
})
