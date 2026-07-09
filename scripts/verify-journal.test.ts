/**
 * Behavior pins for the pure {@link verify} journal checker exported by
 * `./verify-journal.ts`.
 *
 * `verify` folds a session's `JournalEvent`s into a `VerifyResult`
 * (`failures` / `parked` plus the `turnCount` / `hopGroups` / `rebuiltCount`
 * accounting) — the shape the CLI turns into its OK / PARKED / FAIL exit. These
 * cases freeze the EXACT result for the three outcomes the checker distinguishes,
 * with inputs built from the real Journal event constructors and the real
 * `Prompt` part/message constructors and expectations captured by running the
 * real implementation:
 *
 * - COMPLETE turn (tool-call resolved by a tool-result, an authoritative
 *   `hop-messages` event carrying both parts, terminal `done`): no failures, no
 *   parked notes — the OK path.
 * - PARKED turn (tool-call with no tool-result and no `hop-messages` yet): both
 *   parked notes, no failures — the fatal-without-`--allow-parked` path.
 * - CORRUPT journals (granular tool events but no `hop-messages`; and a
 *   `hop-messages` whose messages omit the granular call/result): failures, no
 *   parked notes — the FAIL path. The empty-journal edge is pinned too.
 *
 * `verify` correlates a turn's hop messages by matching each `user-message`
 * envelope `seq` to the tool events' `turn`, so every scenario numbers its
 * user-message `seq` to equal that turn.
 *
 * @module
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { Prompt } from "effect/unstable/ai"
import {
  JournalDone,
  JournalEvent,
  JournalHopMessages,
  JournalToolCall,
  JournalToolResult,
  JournalUserMessage,
} from "../packages/shared/src/index.ts"
import { verify } from "./verify-journal.ts"

/** Envelope one payload; `createdAt` is irrelevant to `verify` and fixed at 0. */
const ev = (seq: number, event: JournalEvent["event"]): JournalEvent => new JournalEvent({ seq, createdAt: 0, event })

const callPart = (id: string): Prompt.ToolCallPart =>
  Prompt.toolCallPart({ id, name: "Bash", params: { command: "ls -la" }, providerExecuted: false })

const resultPart = (id: string): Prompt.ToolResultPart =>
  Prompt.toolResultPart({ id, name: "Bash", isFailure: false, result: "ok" })

describe("verify", () => {
  it.effect("COMPLETE turn: tool-call resolved and folded into hop-messages -> OK", () =>
    Effect.sync(() => {
      const events: ReadonlyArray<JournalEvent> = [
        ev(1, new JournalUserMessage({ content: "list files" })),
        ev(2, new JournalToolCall({ turn: 1, hop: 0, part: callPart("call_1") })),
        ev(3, new JournalToolResult({ turn: 1, hop: 0, part: resultPart("call_1") })),
        ev(
          4,
          new JournalHopMessages({
            turn: 1,
            hop: 0,
            messages: [
              Prompt.assistantMessage({ content: [callPart("call_1")] }),
              Prompt.toolMessage({ content: [resultPart("call_1")] }),
            ],
          }),
        ),
        ev(5, new JournalDone({ turn: 1, finishReason: "stop", toolCallCount: 1 })),
      ]

      const result = verify(events)

      expect(result.failures).toStrictEqual([])
      expect(result.parked).toStrictEqual([])
      expect(result.turnCount).toBe(1)
      expect(result.hopGroups).toBe(1)
      expect(result.rebuiltCount).toBe(3)
    }))

  it.effect("PARKED turn: tool-call with no result and no hop-messages -> parked, no failures", () =>
    Effect.sync(() => {
      const events: ReadonlyArray<JournalEvent> = [
        ev(1, new JournalUserMessage({ content: "run the build" })),
        ev(2, new JournalToolCall({ turn: 1, hop: 0, part: callPart("call_1") })),
      ]

      const result = verify(events)

      expect(result.failures).toStrictEqual([])
      expect(result.parked).toStrictEqual([
        "turn=1 hop=0: tool-call Bash (call_1) has no tool-result — parked/incomplete turn",
        "turn=1 hop=0: no hop-messages event — parked hop (batched only at hop end)",
      ])
      expect(result.turnCount).toBe(1)
      expect(result.hopGroups).toBe(1)
      expect(result.rebuiltCount).toBe(1)
    }))

  it.effect("CORRUPT journal: granular tool events but no hop-messages -> failure", () =>
    Effect.sync(() => {
      const events: ReadonlyArray<JournalEvent> = [
        ev(1, new JournalUserMessage({ content: "corrupt case" })),
        ev(2, new JournalToolCall({ turn: 1, hop: 0, part: callPart("call_1") })),
        ev(3, new JournalToolResult({ turn: 1, hop: 0, part: resultPart("call_1") })),
      ]

      const result = verify(events)

      expect(result.parked).toStrictEqual([])
      expect(result.failures).toStrictEqual([
        "turn=1 hop=0: granular tool events exist but no hop-messages event",
      ])
      expect(result.turnCount).toBe(1)
    }))

  it.effect("CORRUPT journal: hop-messages omits the granular call and result -> failures", () =>
    Effect.sync(() => {
      const events: ReadonlyArray<JournalEvent> = [
        ev(1, new JournalUserMessage({ content: "missing case" })),
        ev(2, new JournalToolCall({ turn: 1, hop: 0, part: callPart("call_1") })),
        ev(3, new JournalToolResult({ turn: 1, hop: 0, part: resultPart("call_1") })),
        ev(
          4,
          new JournalHopMessages({
            turn: 1,
            hop: 0,
            messages: [Prompt.assistantMessage({ content: [Prompt.textPart({ text: "no tool parts here" })] })],
          }),
        ),
      ]

      const result = verify(events)

      expect(result.parked).toStrictEqual([])
      expect(result.failures).toStrictEqual([
        "turn=1 hop=0: tool-call Bash (call_1) missing from hop-messages",
        "turn=1 hop=0: tool-result (call_1) missing from hop-messages",
      ])
    }))

  it.effect("empty journal: nothing to rebuild -> failure", () =>
    Effect.sync(() => {
      const result = verify([])

      expect(result.failures).toStrictEqual(["no user-message events found — nothing to rebuild"])
      expect(result.parked).toStrictEqual([])
      expect(result.turnCount).toBe(0)
      expect(result.hopGroups).toBe(0)
      expect(result.rebuiltCount).toBe(0)
    }))
})
