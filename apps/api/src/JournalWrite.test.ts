/**
 * Pure table-tests for the two journal-derivation builders in `JournalWrite.ts`
 * that turn a model hop's raw response parts into journal events:
 * `buildUsageEvent` (token/cost accounting from the `finish` part) and
 * `buildHopEvents` (granular tool events + the authoritative `hop-messages`).
 *
 * Both take real `Response` parts built through the canonical constructors, so
 * a shape change in the Effect-beta `Response`/`Prompt` mapping breaks the test
 * rather than silently drifting the journal. The OpenRouter `cost` cases pin the
 * schema-first decode: it is read from `metadata.openrouter.usage`, a field the
 * generated usage type omits, and a malformed value must be swallowed (the
 * decode returns a failed `Result`, never throws).
 *
 * @module
 */
import { describe, expect, it } from "@effect/vitest"
import { JournalHopMessages, JournalUsage } from "@efflux/shared"
import { Effect } from "effect"
import { Prompt, Response as AiResponse } from "effect/unstable/ai"
import { buildHopEvents, buildUsageEvent } from "./JournalWrite.ts"

/** Token usage (10 input, 5 output) reused by every `finish` part below. */
const tokenUsage = new AiResponse.Usage({
  inputTokens: {
    total: 10,
    uncached: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 5, text: undefined, reasoning: undefined },
})

/**
 * A well-formed OpenRouter raw-usage object carrying `cost`. Declared as a
 * standalone binding so the `cost` field (absent from the generated usage type)
 * survives structural assignment instead of tripping excess-property checking.
 */
const openRouterUsageWithCost = {
  prompt_tokens: 10,
  completion_tokens: 5,
  total_tokens: 15,
  cost: 0.0125,
}

/** Same raw-usage object but with a non-numeric `cost` the decode must reject. */
const openRouterUsageMalformedCost = {
  prompt_tokens: 10,
  completion_tokens: 5,
  total_tokens: 15,
  cost: "expensive",
}

const finishNoMetadata = AiResponse.makePart("finish", {
  reason: "stop",
  usage: tokenUsage,
  response: undefined,
})

const finishWithCost = AiResponse.makePart("finish", {
  reason: "stop",
  usage: tokenUsage,
  response: undefined,
  metadata: { openrouter: { usage: openRouterUsageWithCost } },
})

const finishMalformedCost = AiResponse.makePart("finish", {
  reason: "stop",
  usage: tokenUsage,
  response: undefined,
  metadata: { openrouter: { usage: openRouterUsageMalformedCost } },
})

const textPart = AiResponse.makePart("text", { text: "just talking" })

const toolCallA = AiResponse.makePart("tool-call", {
  id: "call-A",
  name: "Bash",
  params: { command: "ls -la" },
  providerExecuted: false,
})

const toolCallB = AiResponse.makePart("tool-call", {
  id: "call-B",
  name: "Bash",
  params: { command: "pwd" },
  providerExecuted: false,
})

const toolResultA = AiResponse.makePart("tool-result", {
  id: "call-A",
  name: "Bash",
  isFailure: false,
  result: { stdout: "total 0", exitCode: 0 },
  encodedResult: { stdout: "total 0", exitCode: 0 },
  preliminary: false,
  providerExecuted: false,
})

const toolResultB = AiResponse.makePart("tool-result", {
  id: "call-B",
  name: "Bash",
  isFailure: false,
  result: { stdout: "/root", exitCode: 0 },
  encodedResult: { stdout: "/root", exitCode: 0 },
  preliminary: false,
  providerExecuted: false,
})

/** Expected token/cost fields, or `undefined` when no usage event is emitted. */
type UsageExpectation = {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
  readonly cost?: number
}

const usageCases: ReadonlyArray<{
  readonly name: string
  readonly input: Parameters<typeof buildUsageEvent>[0]
  readonly expected: UsageExpectation | undefined
}> = [
  {
    name: "no finish part (empty parts) -> undefined",
    input: { turn: 1, hop: 0, model: "test/model", parts: [] },
    expected: undefined,
  },
  {
    name: "no finish part (text only) -> undefined",
    input: { turn: 1, hop: 0, model: "test/model", parts: [textPart] },
    expected: undefined,
  },
  {
    name: "input + output tokens -> totalTokens is their sum",
    input: { turn: 2, hop: 1, model: "test/model", parts: [finishNoMetadata] },
    expected: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  },
  {
    name: "OpenRouter cost present -> included",
    input: { turn: 3, hop: 0, model: "test/model", parts: [finishWithCost] },
    expected: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cost: 0.0125 },
  },
  {
    name: "malformed cost -> decode swallowed, cost omitted",
    input: { turn: 4, hop: 2, model: "test/model", parts: [finishMalformedCost] },
    expected: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  },
]

describe("buildUsageEvent", () => {
  for (const testCase of usageCases) {
    it.effect(testCase.name, () =>
      Effect.sync(() => {
        const result = buildUsageEvent(testCase.input)
        if (testCase.expected === undefined) {
          expect(result).toBeUndefined()
          return
        }
        expect(result).toBeInstanceOf(JournalUsage)
        expect(result?.turn).toBe(testCase.input.turn)
        expect(result?.hop).toBe(testCase.input.hop)
        expect(result?.model).toBe(testCase.input.model)
        expect(result?.inputTokens).toBe(testCase.expected.inputTokens)
        expect(result?.outputTokens).toBe(testCase.expected.outputTokens)
        expect(result?.totalTokens).toBe(testCase.expected.totalTokens)
        expect(result?.cost).toBe(testCase.expected.cost)
      }))
  }
})

const hopCases: ReadonlyArray<{
  readonly name: string
  readonly input: Parameters<typeof buildHopEvents>[0]
  readonly expectedTags: ReadonlyArray<string>
}> = [
  {
    name: "empty parts -> []",
    input: { turn: 1, hop: 0, parts: [] },
    expectedTags: [],
  },
  {
    name: "text only -> trailing hop-messages, no tool events",
    input: { turn: 1, hop: 0, parts: [textPart] },
    expectedTags: ["hop-messages"],
  },
  {
    name: "one call + result -> tool-call, tool-result, hop-messages",
    input: { turn: 2, hop: 1, parts: [toolCallA, toolResultA] },
    expectedTags: ["tool-call", "tool-result", "hop-messages"],
  },
  {
    name: "two calls + results -> all calls, then all results, then hop-messages",
    input: {
      turn: 3,
      hop: 0,
      parts: [toolCallA, toolCallB, toolResultA, toolResultB],
    },
    expectedTags: [
      "tool-call",
      "tool-call",
      "tool-result",
      "tool-result",
      "hop-messages",
    ],
  },
]

describe("buildHopEvents", () => {
  for (const testCase of hopCases) {
    it.effect(testCase.name, () =>
      Effect.sync(() => {
        const events = buildHopEvents(testCase.input)
        expect(events.map((event) => event._tag)).toStrictEqual(testCase.expectedTags)
        if (testCase.expectedTags.length === 0) {
          expect(events).toStrictEqual([])
          return
        }
        const last = events[events.length - 1]
        expect(last).toBeInstanceOf(JournalHopMessages)
        if (last instanceof JournalHopMessages) {
          expect(last.messages).toStrictEqual(
            Prompt.fromResponseParts(testCase.input.parts).content,
          )
        }
      }))
  }
})
