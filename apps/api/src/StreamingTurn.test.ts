/**
 * Table-test pinning `toFramedPart` — the pure seq-stamping mapper that turns
 * one `AiResponse.StreamPart` into an SSE-bound `StreamPart` plus its backing
 * journal seq. It freezes the display-frame contract the streaming driver
 * depends on: which response parts surface as which wire frames, that the
 * backing `seq` rides through untouched, that a `tool-approval-request`
 * without a seq is dropped (`Result.fail`), and that any part the mapper does
 * not recognize is dropped too.
 *
 * Inputs are built with the real `Response` constructors from
 * `effect/unstable/ai` (import style mirrored from `StreamingTurn.ts`), and
 * expectations are real `@efflux/shared` `StreamPart` instances compared
 * structurally, so a shape drift on either side of the map breaks the test.
 *
 * @module
 */
import { describe, expect, it } from "@effect/vitest"
import {
  type StreamPart,
  StreamPartApprovalRequest,
  StreamPartDone,
  StreamPartTextDelta,
  StreamPartToolCall,
  StreamPartToolResult,
} from "@efflux/shared"
import { Effect, Result } from "effect"
import { Response as AiResponse } from "effect/unstable/ai"
import { toFramedPart } from "./StreamingTurn.ts"

/** The exact input element shape `toFramedPart` accepts (part + backing seq). */
type FramedInput = Parameters<typeof toFramedPart>[0]

/** Expected outcome of one mapping: a success carrying the framed SSE part + seq, or the drop path. */
type Expectation =
  | { readonly ok: true; readonly sse: StreamPart; readonly seq: number | undefined }
  | { readonly ok: false }

/** A zeroed `Usage` — `toFramedPart` only reads `finish.reason`, so token counts are immaterial. */
const usage = new AiResponse.Usage({
  inputTokens: { uncached: undefined, total: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
})

const cases: ReadonlyArray<{
  readonly name: string
  readonly input: FramedInput
  readonly expected: Expectation
}> = [
  {
    name: "text-delta -> StreamPartTextDelta (seq rides through untouched)",
    input: {
      part: AiResponse.makePart("text-delta", { id: "t1", delta: "hello" }),
      seq: undefined,
    },
    expected: { ok: true, sse: new StreamPartTextDelta({ delta: "hello" }), seq: undefined },
  },
  {
    name: "tool-call -> StreamPartToolCall (numeric seq preserved)",
    input: {
      part: AiResponse.makePart("tool-call", {
        id: "call_1",
        name: "Bash",
        params: { command: "ls -la" },
        providerExecuted: false,
      }),
      seq: 3,
    },
    expected: {
      ok: true,
      sse: new StreamPartToolCall({ id: "call_1", name: "Bash", params: { command: "ls -la" } }),
      seq: 3,
    },
  },
  {
    name: "tool-result -> StreamPartToolResult (decoded result + isFailure preserved)",
    input: {
      part: AiResponse.toolResultPart({
        id: "call_1",
        name: "Bash",
        result: { stdout: "total 0", exitCode: 0, stderr: "" },
        encodedResult: { stdout: "total 0", exitCode: 0, stderr: "" },
        isFailure: false,
        providerExecuted: false,
        preliminary: false,
      }),
      seq: 5,
    },
    expected: {
      ok: true,
      sse: new StreamPartToolResult({
        id: "call_1",
        result: { stdout: "total 0", exitCode: 0, stderr: "" },
        isFailure: false,
      }),
      seq: 5,
    },
  },
  {
    name: "finish -> StreamPartDone (reason mapped, toolCallCount 0)",
    input: {
      part: AiResponse.makePart("finish", { reason: "stop", usage, response: undefined }),
      seq: 8,
    },
    expected: {
      ok: true,
      sse: new StreamPartDone({ finishReason: "stop", toolCallCount: 0 }),
      seq: 8,
    },
  },
  {
    name: "tool-approval-request with numeric seq -> StreamPartApprovalRequest (eventId: seq)",
    input: {
      part: AiResponse.toolApprovalRequestPart({ approvalId: "appr_1", toolCallId: "call_1" }),
      seq: 7,
    },
    expected: {
      ok: true,
      sse: new StreamPartApprovalRequest({ eventId: 7, approvalId: "appr_1", toolCallId: "call_1" }),
      seq: 7,
    },
  },
  {
    name: "tool-approval-request with seq === undefined -> Result.fail (dropped)",
    input: {
      part: AiResponse.toolApprovalRequestPart({ approvalId: "appr_1", toolCallId: "call_1" }),
      seq: undefined,
    },
    expected: { ok: false },
  },
  {
    name: "unknown part (text-start) -> Result.fail (dropped)",
    input: {
      part: AiResponse.makePart("text-start", { id: "ts1" }),
      seq: undefined,
    },
    expected: { ok: false },
  },
]

describe("toFramedPart", () => {
  for (const testCase of cases) {
    it.effect(testCase.name, () =>
      Effect.sync(() => {
        const result = toFramedPart(testCase.input)
        const expected = testCase.expected
        if (expected.ok) {
          expect(Result.isSuccess(result)).toBe(true)
          if (Result.isSuccess(result)) {
            expect(result.success.sse._tag).toBe(expected.sse._tag)
            expect(result.success.sse).toStrictEqual(expected.sse)
            expect(result.success.seq).toBe(expected.seq)
          }
        } else {
          expect(Result.isFailure(result)).toBe(true)
        }
      }))
  }
})
