/**
 * Pure-unit pins for the journal selectors in `./journal.ts` —
 * `pendingApprovals`, `toolCallResults`, and the `latestTurnInFlight` liveness
 * predicate. All are total pure functions over a decoded `JournalEvent[]`, so
 * they are exercised directly on hand-built event arrays: no React render, no
 * live `ApiClient`, no SSE.
 *
 * `./journal.ts` value-imports `../runtime.ts`, whose `ApiClient.layer` static
 * initializer reads `window.location.origin` at module-load. Under vitest's
 * `node` environment there is no `window`, so the module is pulled in via a
 * dynamic import AFTER a minimal `window` global is stubbed — the selectors
 * themselves never touch it.
 *
 * The correlation contract under test: an `approval-requested` is enriched from
 * the `tool-call` sharing its `(turn, hop)` whose `part.id` equals the
 * `toolCallId`, and is surfaced under the ENVELOPE `seq` (not any payload field);
 * a `tool-call` is paired with the `tool-result` sharing its `(turn, hop)` and
 * `part.id`. A mismatch on any correlation key must leave the enrichment keys
 * ABSENT (not present-but-undefined) — enforced by both `toStrictEqual` and an
 * explicit `Object.keys` assertion.
 *
 * @module
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { Prompt } from "effect/unstable/ai"
import { vi } from "vitest"
import {
  JournalApprovalRequested,
  JournalApprovalResolved,
  JournalAssistantText,
  JournalDone,
  JournalErrorEvent,
  JournalEvent,
  JournalSessionClosed,
  JournalToolCall,
  JournalToolResult,
  JournalUserMessage,
} from "@efflux/shared"

vi.stubGlobal("window", { location: { origin: "http://localhost" } })

const { latestTurnInFlight, pendingApprovals, toolCallResults } = await import("./journal.ts")

/** Wrap an event payload in a journal envelope at the given `seq` — the value `pendingApprovals` must surface as `eventId`. */
const evt = (seq: number, event: JournalEvent["event"]): JournalEvent =>
  new JournalEvent({ seq, createdAt: 1_700_000_000_000, event })

/** A `tool-call` payload with a caller-chosen `(turn, hop)` and part id/name/params. */
const toolCall = (turn: number, hop: number, id: string, name: string, params: unknown): JournalToolCall =>
  new JournalToolCall({ turn, hop, part: Prompt.toolCallPart({ id, name, params, providerExecuted: false }) })

/** A `tool-result` payload keyed by `(turn, hop)` and the originating call's `id`. */
const toolResult = (turn: number, hop: number, id: string, name: string, result: unknown): JournalToolResult =>
  new JournalToolResult({ turn, hop, part: Prompt.toolResultPart({ id, name, isFailure: false, result }) })

describe("pendingApprovals", () => {
  it.effect("surfaces an unresolved approval under envelope.seq (not a payload id) with tool enrichment", () =>
    Effect.sync(() => {
      const events = [
        evt(7, toolCall(1, 0, "call_1", "Bash", { command: "ls -la" })),
        evt(42, new JournalApprovalRequested({ turn: 1, hop: 0, approvalId: "appr_1", toolCallId: "call_1" })),
      ]
      expect(pendingApprovals(events)).toStrictEqual([
        {
          eventId: 42,
          approvalId: "appr_1",
          toolCallId: "call_1",
          turn: 1,
          hop: 0,
          toolName: "Bash",
          toolParams: { command: "ls -la" },
        },
      ])
    }))

  it.effect("drops a resolved approval while keeping a sibling that is still parked", () =>
    Effect.sync(() => {
      const events = [
        evt(1, toolCall(1, 0, "call_1", "Bash", { command: "ls" })),
        evt(2, new JournalApprovalRequested({ turn: 1, hop: 0, approvalId: "appr_1", toolCallId: "call_1" })),
        evt(3, toolCall(1, 1, "call_2", "Read", { path: "/etc/hosts" })),
        evt(4, new JournalApprovalRequested({ turn: 1, hop: 1, approvalId: "appr_2", toolCallId: "call_2" })),
        evt(5, new JournalApprovalResolved({ turn: 1, approvalId: "appr_1", approved: true })),
      ]
      const pending = pendingApprovals(events)
      expect(pending.map((approval) => approval.approvalId)).toStrictEqual(["appr_2"])
      expect(pending[0]?.eventId).toBe(4)
    }))

  it.effect("does not cross-match a tool-call from a different (turn, hop) or id — enrichment keys stay ABSENT", () =>
    Effect.sync(() => {
      const events = [
        evt(1, toolCall(2, 0, "call_1", "Bash", { command: "ls" })),
        evt(2, toolCall(1, 0, "call_9", "Read", { path: "/x" })),
        evt(3, new JournalApprovalRequested({ turn: 1, hop: 0, approvalId: "appr_1", toolCallId: "call_1" })),
      ]
      const pending = pendingApprovals(events)
      expect(pending).toStrictEqual([
        { eventId: 3, approvalId: "appr_1", toolCallId: "call_1", turn: 1, hop: 0 },
      ])
      expect(Object.keys(pending[0] ?? {}).sort()).toStrictEqual(
        ["approvalId", "eventId", "hop", "toolCallId", "turn"],
      )
    }))
})

describe("toolCallResults", () => {
  it.effect("pairs each call with its journalled result by (turn, hop, id) and preserves tool-call order", () =>
    Effect.sync(() => {
      const call1 = toolCall(1, 0, "call_1", "Bash", { command: "ls" })
      const call2 = toolCall(1, 1, "call_2", "Read", { path: "/etc/hosts" })
      const res1 = toolResult(1, 0, "call_1", "Bash", { stdout: "ok", exitCode: 0 })
      const pairs = toolCallResults([evt(1, call1), evt(2, call2), evt(3, res1)])
      expect(pairs).toHaveLength(2)
      expect(pairs[0]?.call).toBe(call1)
      expect(pairs[0]?.result).toBe(res1)
      expect(pairs[1]?.call).toBe(call2)
      expect(Object.keys(pairs[1] ?? {})).toStrictEqual(["call"])
    }))

  it.effect("leaves the result key ABSENT for a call with no journalled result", () =>
    Effect.sync(() => {
      const call = toolCall(1, 0, "call_1", "Bash", { command: "ls" })
      const pairs = toolCallResults([evt(1, call)])
      expect(pairs).toHaveLength(1)
      expect(pairs[0]?.call).toBe(call)
      expect(Object.keys(pairs[0] ?? {})).toStrictEqual(["call"])
    }))

  it.effect("does not cross-match a result from a different (turn, hop) or id — result stays ABSENT", () =>
    Effect.sync(() => {
      const call = toolCall(1, 0, "call_1", "Bash", { command: "ls" })
      const wrongTurn = toolResult(9, 0, "call_1", "Bash", { stdout: "nope" })
      const wrongId = toolResult(1, 0, "call_9", "Bash", { stdout: "nope" })
      const pairs = toolCallResults([evt(1, call), evt(2, wrongTurn), evt(3, wrongId)])
      expect(pairs).toHaveLength(1)
      expect(pairs[0]?.call).toBe(call)
      expect(Object.keys(pairs[0] ?? {})).toStrictEqual(["call"])
    }))
})

describe("latestTurnInFlight", () => {
  it.effect("returns false when no user-message anchors a turn", () =>
    Effect.sync(() => {
      expect(latestTurnInFlight([])).toBe(false)
      expect(latestTurnInFlight([evt(1, toolCall(1, 0, "call_1", "Bash", { command: "ls" }))])).toBe(false)
    }))

  it.effect("returns true while the latest turn is still open", () =>
    Effect.sync(() => {
      const events = [
        evt(10, new JournalUserMessage({ content: "hello" })),
        evt(11, new JournalAssistantText({ turn: 10, hop: 0, text: "working" })),
      ]
      expect(latestTurnInFlight(events)).toBe(true)
    }))

  it.effect("returns false once the latest turn is done", () =>
    Effect.sync(() => {
      const events = [
        evt(10, new JournalUserMessage({ content: "hello" })),
        evt(12, new JournalDone({ turn: 10, finishReason: "stop", toolCallCount: 0 })),
      ]
      expect(latestTurnInFlight(events)).toBe(false)
    }))

  it.effect("returns false once the latest turn errors", () =>
    Effect.sync(() => {
      const events = [
        evt(10, new JournalUserMessage({ content: "hello" })),
        evt(12, new JournalErrorEvent({ turn: 10, message: "boom" })),
      ]
      expect(latestTurnInFlight(events)).toBe(false)
    }))

  it.effect("returns false while the latest turn is parked on an unresolved approval", () =>
    Effect.sync(() => {
      const events = [
        evt(10, new JournalUserMessage({ content: "hello" })),
        evt(11, new JournalApprovalRequested({ turn: 10, hop: 0, approvalId: "a1", toolCallId: "t1" })),
      ]
      expect(latestTurnInFlight(events)).toBe(false)
    }))

  it.effect("returns true once the parked approval on the latest turn is resolved", () =>
    Effect.sync(() => {
      const events = [
        evt(10, new JournalUserMessage({ content: "hello" })),
        evt(11, new JournalApprovalRequested({ turn: 10, hop: 0, approvalId: "a1", toolCallId: "t1" })),
        evt(12, new JournalApprovalResolved({ turn: 10, approvalId: "a1", approved: true })),
      ]
      expect(latestTurnInFlight(events)).toBe(true)
    }))

  it.effect("ignores a terminal on a prior turn — the latest open turn is in flight", () =>
    Effect.sync(() => {
      const events = [
        evt(5, new JournalUserMessage({ content: "first" })),
        evt(6, new JournalDone({ turn: 5, finishReason: "stop", toolCallCount: 0 })),
        evt(10, new JournalUserMessage({ content: "second" })),
      ]
      expect(latestTurnInFlight(events)).toBe(true)
    }))

  it.effect("returns false once the session is closed", () =>
    Effect.sync(() => {
      const events = [
        evt(10, new JournalUserMessage({ content: "hello" })),
        evt(11, new JournalSessionClosed({ reason: "closed" })),
      ]
      expect(latestTurnInFlight(events)).toBe(false)
    }))
})
