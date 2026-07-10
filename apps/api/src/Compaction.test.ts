/**
 * Characterization of the PURE {@link planCompaction} core: fold journal events
 * into turns, keep the last {@link KEEP_RECENT_TURNS} beyond the prior watermark
 * verbatim, and chain the prior summary. The model call and the orchestrator are
 * exercised in the live smoke, not here — these cases pin only the pure planner.
 *
 * Synthetic {@link ReconstructEvent}s are built from the real `@efflux/shared`
 * constructors with hand-assigned seqs so a schema-shape change breaks the test.
 *
 * @module
 */
import { describe, expect, it } from "@effect/vitest"
import {
  JournalAssistantText,
  type JournalEventPayload,
  JournalCompaction,
  JournalUserMessage,
} from "@efflux/shared"
import { Effect } from "effect"
import { KEEP_RECENT_TURNS, planCompaction } from "./Compaction.ts"
import type { ReconstructEvent } from "./Reconstruct.ts"

const row = (seq: number, event: JournalEventPayload): ReconstructEvent => ({ seq, event })

const user = (seq: number, content: string): ReconstructEvent =>
  row(seq, new JournalUserMessage({ content }))

const assistant = (seq: number, turn: number, hop: number, text: string): ReconstructEvent =>
  row(seq, new JournalAssistantText({ turn, hop, text }))

const compaction = (seq: number, throughSeq: number, summary: string): ReconstructEvent =>
  row(seq, new JournalCompaction({ throughSeq, summary }))

describe("planCompaction", () => {
  it.effect("(a) fewer than KEEP_RECENT_TURNS + 1 eligible turns ⇒ undefined", () =>
    Effect.sync(() => {
      const events = [
        user(1, "u1"),
        assistant(2, 1, 0, "a1"),
        user(3, "u2"),
        assistant(4, 3, 0, "a2"),
      ]
      expect(events.length).toBeGreaterThan(KEEP_RECENT_TURNS)
      expect(planCompaction(events)).toBeUndefined()
    }),
  )

  it.effect("(b) N > KEEP eligible turns, no prior compaction ⇒ folds the leading N-KEEP", () =>
    Effect.sync(() => {
      const events = [
        user(1, "u1"),
        assistant(2, 1, 0, "a1"),
        user(3, "u2"),
        assistant(4, 3, 0, "a2"),
        user(5, "u3"),
        assistant(6, 5, 0, "a3"),
        user(7, "u4"),
        assistant(8, 7, 0, "a4"),
      ]
      const plan = planCompaction(events)
      expect(plan).not.toBeUndefined()
      expect(plan?.throughSeq).toBe(3)
      expect(plan?.priorSummary).toBeUndefined()
      expect(plan?.olderMessages).toStrictEqual([
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u2" },
        { role: "assistant", content: "a2" },
      ])
    }),
  )

  it.effect("(c) prior compaction ⇒ only turns past its throughSeq are eligible; priorSummary chains", () =>
    Effect.sync(() => {
      const events = [
        user(1, "u1"),
        assistant(2, 1, 0, "a1"),
        user(3, "u2"),
        assistant(4, 3, 0, "a2"),
        user(5, "u3"),
        assistant(6, 5, 0, "a3"),
        user(7, "u4"),
        assistant(8, 7, 0, "a4"),
        compaction(9, 1, "prev summary"),
      ]
      const plan = planCompaction(events)
      expect(plan).not.toBeUndefined()
      expect(plan?.priorSummary).toBe("prev summary")
      expect(plan?.throughSeq).toBe(3)
      expect(plan?.olderMessages).toStrictEqual([
        { role: "user", content: "u2" },
        { role: "assistant", content: "a2" },
      ])
    }),
  )

  it.effect("(d) two assistant-text events for one turn concatenate into ONE assistant message", () =>
    Effect.sync(() => {
      const events = [
        user(1, "u1"),
        assistant(2, 1, 0, "a1a"),
        assistant(3, 1, 1, "a1b"),
        user(4, "u2"),
        assistant(5, 4, 0, "a2"),
        user(6, "u3"),
        assistant(7, 6, 0, "a3"),
      ]
      const plan = planCompaction(events)
      expect(plan).not.toBeUndefined()
      expect(plan?.throughSeq).toBe(1)
      expect(plan?.olderMessages).toStrictEqual([
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1aa1b" },
      ])
    }),
  )
})
