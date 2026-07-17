/**
 * Behavior pins for the pure eval-core extractors exported by `./eval-core.ts`.
 *
 * Every fixture is HAND-CONSTRUCTED from the real Journal event constructors and
 * the real `Prompt` part constructors — no schema arbitraries. `SessionArchive`
 * transitively embeds the regex-refined `SafeName`, whose `Schema.toArbitrary`
 * generator exhausts FastCheck's `.filter` (a CLAUDE.md landmine), so fixtures
 * use fixed literal fields throughout. Tool-call parts are built exactly as
 * `verify-journal.test.ts` builds them.
 *
 * @module
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { Prompt } from "effect/unstable/ai"
import {
  JournalAssistantText,
  JournalDone,
  JournalErrorEvent,
  JournalEvent,
  JournalToolCall,
  JournalUserMessage,
  SessionArchive,
} from "../packages/shared/src/index.ts"
import { buildJudgePrompt, diffTrajectory, extractTrajectory, extractUserTurns, finalAnswer, parseJudgeVerdict } from "./eval-core.ts"
import type { TurnTrajectory } from "./eval-core.ts"

/** Envelope one payload; `createdAt` is irrelevant to the pure extractors and fixed at 0. */
const ev = (seq: number, event: JournalEvent["event"]): JournalEvent => new JournalEvent({ seq, createdAt: 0, event })

/** A `Prompt.ToolCallPart` with the given tool `name`, built exactly as `verify-journal.test.ts` constructs one. */
const callPart = (id: string, name: string): Prompt.ToolCallPart =>
  Prompt.toolCallPart({ id, name, params: { command: "ls -la" }, providerExecuted: false })

/** A bare {@link TurnTrajectory} literal for the diff cases. */
const traj = (
  turn: number,
  tools: ReadonlyArray<string>,
  finishReason: string | undefined,
  errored: boolean,
): TurnTrajectory => ({ turn, tools, finishReason, errored })

describe("extractTrajectory", () => {
  it.effect("groups turn-bearing events by turn with ordered tool names and finish reasons", () =>
    Effect.sync(() => {
      const events: ReadonlyArray<JournalEvent> = [
        ev(1, new JournalUserMessage({ content: "list then summarize" })),
        ev(2, new JournalToolCall({ turn: 1, hop: 0, part: callPart("call_x", "Bash") })),
        ev(3, new JournalToolCall({ turn: 1, hop: 0, part: callPart("call_y", "Grep") })),
        ev(4, new JournalDone({ turn: 1, finishReason: "tool-calls", toolCallCount: 2 })),
        ev(5, new JournalUserMessage({ content: "thanks" })),
        ev(6, new JournalAssistantText({ turn: 2, hop: 0, text: "done" })),
        ev(7, new JournalDone({ turn: 2, finishReason: "stop", toolCallCount: 0 })),
      ]

      expect(extractTrajectory(events)).toStrictEqual([
        traj(1, ["Bash", "Grep"], "tool-calls", false),
        traj(2, [], "stop", false),
      ])
    }))

  it.effect("marks a turn errored when it carries an error event", () =>
    Effect.sync(() => {
      const events: ReadonlyArray<JournalEvent> = [
        ev(1, new JournalUserMessage({ content: "do something" })),
        ev(2, new JournalToolCall({ turn: 1, hop: 0, part: callPart("call_e", "Bash") })),
        ev(3, new JournalErrorEvent({ turn: 1, message: "boom" })),
      ]

      expect(extractTrajectory(events)).toStrictEqual([traj(1, ["Bash"], undefined, true)])
    }))
})

describe("finalAnswer", () => {
  it.effect("concatenates the last turn's assistant text across hops in seq order", () =>
    Effect.sync(() => {
      const events: ReadonlyArray<JournalEvent> = [
        ev(1, new JournalUserMessage({ content: "q1" })),
        ev(2, new JournalAssistantText({ turn: 1, hop: 0, text: "first turn answer" })),
        ev(3, new JournalDone({ turn: 1, finishReason: "stop", toolCallCount: 0 })),
        ev(4, new JournalUserMessage({ content: "q2" })),
        ev(5, new JournalAssistantText({ turn: 2, hop: 0, text: "Hello " })),
        ev(6, new JournalAssistantText({ turn: 2, hop: 1, text: "world" })),
        ev(7, new JournalDone({ turn: 2, finishReason: "stop", toolCallCount: 0 })),
      ]

      expect(finalAnswer(events)).toBe("Hello world")
    }))

  it.effect("returns the empty string when there is no assistant text", () =>
    Effect.sync(() => {
      expect(finalAnswer([])).toBe("")
    }))
})

describe("extractUserTurns", () => {
  it.effect("returns user-message contents in insertion order", () =>
    Effect.sync(() => {
      const archive = new SessionArchive({
        name: "sess",
        id: "abc",
        closedAt: 0,
        reason: "closed",
        events: [
          ev(1, new JournalUserMessage({ content: "first question" })),
          ev(2, new JournalAssistantText({ turn: 1, hop: 0, text: "reply" })),
          ev(3, new JournalUserMessage({ content: "second question" })),
          ev(4, new JournalUserMessage({ content: "third question" })),
        ],
      })

      expect(extractUserTurns(archive).map((u) => u.content)).toStrictEqual([
        "first question",
        "second question",
        "third question",
      ])
    }))
})

describe("diffTrajectory", () => {
  it.effect("identical trajectories match with no differences", () =>
    Effect.sync(() => {
      const base: ReadonlyArray<TurnTrajectory> = [traj(1, ["Bash"], "stop", false)]

      expect(diffTrajectory(base, base)).toStrictEqual({ matches: true, differences: [] })
    }))

  it.effect("a changed tool order is a difference", () =>
    Effect.sync(() => {
      const base: ReadonlyArray<TurnTrajectory> = [traj(1, ["Bash", "Grep"], "stop", false)]
      const cand: ReadonlyArray<TurnTrajectory> = [traj(1, ["Grep", "Bash"], "stop", false)]

      const result = diffTrajectory(base, cand)

      expect(result.matches).toBe(false)
      expect(result.differences.length).toBeGreaterThan(0)
    }))

  it.effect("a changed finish reason is a difference", () =>
    Effect.sync(() => {
      const base: ReadonlyArray<TurnTrajectory> = [traj(1, ["Bash"], "stop", false)]
      const cand: ReadonlyArray<TurnTrajectory> = [traj(1, ["Bash"], "length", false)]

      const result = diffTrajectory(base, cand)

      expect(result.matches).toBe(false)
      expect(result.differences.length).toBeGreaterThan(0)
    }))

  it.effect("an errored flip is a difference", () =>
    Effect.sync(() => {
      const base: ReadonlyArray<TurnTrajectory> = [traj(1, ["Bash"], "stop", false)]
      const cand: ReadonlyArray<TurnTrajectory> = [traj(1, ["Bash"], "stop", true)]

      const result = diffTrajectory(base, cand)

      expect(result.matches).toBe(false)
      expect(result.differences.length).toBeGreaterThan(0)
    }))

  it.effect("a turn-count mismatch is a difference", () =>
    Effect.sync(() => {
      const base: ReadonlyArray<TurnTrajectory> = [traj(1, ["Bash"], "stop", false)]
      const cand: ReadonlyArray<TurnTrajectory> = [traj(1, ["Bash"], "stop", false), traj(2, [], "stop", false)]

      const result = diffTrajectory(base, cand)

      expect(result.matches).toBe(false)
      expect(result.differences.length).toBeGreaterThan(0)
    }))
})

describe("buildJudgePrompt", () => {
  it.effect("assembles within budget and carries the VERDICT instruction", () =>
    Effect.sync(() => {
      const prompt = buildJudgePrompt({
        userTurns: ["what is 2+2?", "and 3+3?"],
        baselineAnswer: "4, then 6",
        candidateAnswer: "The answers are 4 and 6",
      })

      expect(prompt.length).toBeLessThanOrEqual(8192)
      expect(prompt.includes("VERDICT:")).toBe(true)
    }))

  it.effect("truncates an over-long answer with the marker and stays within budget", () =>
    Effect.sync(() => {
      const prompt = buildJudgePrompt({
        userTurns: ["explain"],
        baselineAnswer: "x".repeat(9000),
        candidateAnswer: "short",
      })

      expect(prompt.length).toBeLessThanOrEqual(8192)
      expect(prompt.includes("…[truncated]")).toBe(true)
    }))
})

describe("parseJudgeVerdict", () => {
  it.effect("parses known verdicts case-insensitively and defaults to inconclusive", () =>
    Effect.sync(() => {
      expect(parseJudgeVerdict("VERDICT: EQUIVALENT")).toBe("equivalent")
      expect(parseJudgeVerdict("verdict: different.")).toBe("different")
      expect(parseJudgeVerdict("blah")).toBe("inconclusive")
      expect(parseJudgeVerdict("")).toBe("inconclusive")
      expect(() => parseJudgeVerdict(" \nweird VERDICT no colon")).not.toThrow()
    }))
})
