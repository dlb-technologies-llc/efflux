/**
 * Decision-table pins for `decideAfterRun` in `JobOutcome.ts` — the pure engine that turns a
 * finished run (exit code, origin, retry policy, attempts used, chain targets) into the next
 * action: a backoff retry, or a final decision carrying a reschedule
 * (`cron`/`dormant`/`exhausted`/`keep`) plus an optional chain target. These are numeric
 * decision-table cases no schema backs, so raw literal inputs rather than schema arbitraries;
 * the fixed `nowMs` keeps every expected timestamp deterministic.
 *
 * @module
 */
import { describe, expect, it } from "@effect/vitest"
import { nextCronOccurrence } from "@efflux/shared"
import { decideAfterRun } from "./JobOutcome.ts"

const nowMs = Date.UTC(2026, 0, 15, 12, 0, 0)

const everyFive = "*/5 * * * *"

/** A syntactically valid cron that can never occur (February 30th) — the exhaustion probe. */
const impossibleCron = "0 0 30 2 *"

const retryTwo = { maxAttempts: 2, backoffSeconds: 30 }

const retryThree = { maxAttempts: 3, backoffSeconds: 60 }

/**
 * Full argument set for `decideAfterRun`, derived from the function signature so every
 * decision-table row stays type-checked against the real API.
 */
type DecideInput = Parameters<typeof decideAfterRun>[0]

/**
 * Baseline row: a failed scheduled run on a real cron with no retry policy, no prior attempts,
 * and no chain targets. Each case overrides only the fields it exercises.
 */
const base: DecideInput = {
  exitCode: 1,
  origin: "schedule",
  cronExpression: everyFive,
  retry: undefined,
  attemptsUsed: 0,
  onSuccessJobId: undefined,
  onFailureJobId: undefined,
  nowMs,
}

const decide = (overrides: Partial<DecideInput>) => decideAfterRun({ ...base, ...overrides })

describe("decideAfterRun", () => {
  describe("retry counting, maxAttempts 2", () => {
    it("first failure retries with attemptsUsed 1 and backoff-shifted nextRunAt", () => {
      expect(decide({ retry: retryTwo })).toEqual({
        _tag: "retry",
        nextRunAt: nowMs + 30_000,
        attemptsUsed: 1,
      })
    })

    it("second failure is final — exactly two total tries per cycle", () => {
      expect(decide({ retry: retryTwo, attemptsUsed: 1 })).toEqual({
        _tag: "final",
        reschedule: { _tag: "cron", nextRunAt: nextCronOccurrence(everyFive, nowMs) },
        chainTargetId: undefined,
      })
    })
  })

  describe("retry counting, maxAttempts 3", () => {
    it("attemptsUsed 0 retries to attemptsUsed 1", () => {
      expect(decide({ retry: retryThree })).toEqual({
        _tag: "retry",
        nextRunAt: nowMs + 60_000,
        attemptsUsed: 1,
      })
    })

    it("attemptsUsed 1 retries to attemptsUsed 2", () => {
      expect(decide({ retry: retryThree, attemptsUsed: 1 })).toEqual({
        _tag: "retry",
        nextRunAt: nowMs + 60_000,
        attemptsUsed: 2,
      })
    })

    it("attemptsUsed 2 is final — exactly three total tries per cycle", () => {
      expect(decide({ retry: retryThree, attemptsUsed: 2 })).toEqual({
        _tag: "final",
        reschedule: { _tag: "cron", nextRunAt: nextCronOccurrence(everyFive, nowMs) },
        chainTargetId: undefined,
      })
    })
  })

  describe("origin rules", () => {
    it("manual origin never retries: a first failure with retry configured is final keep", () => {
      expect(decide({ origin: "manual", retry: retryTwo })).toEqual({
        _tag: "final",
        reschedule: { _tag: "keep" },
        chainTargetId: undefined,
      })
    })

    it("chain-origin first failure retries like a scheduled run", () => {
      expect(decide({ origin: "chain", retry: retryTwo })).toEqual({
        _tag: "retry",
        nextRunAt: nowMs + 30_000,
        attemptsUsed: 1,
      })
    })

    it("success is always final, even with retry configured and budget remaining", () => {
      expect(decide({ exitCode: 0, retry: retryTwo })).toEqual({
        _tag: "final",
        reschedule: { _tag: "cron", nextRunAt: nextCronOccurrence(everyFive, nowMs) },
        chainTargetId: undefined,
      })
    })
  })

  describe("chain-target selection on final", () => {
    it("success routes to onSuccessJobId", () => {
      expect(
        decide({ exitCode: 0, onSuccessJobId: "job-on-success", onFailureJobId: "job-on-failure" }),
      ).toEqual({
        _tag: "final",
        reschedule: { _tag: "cron", nextRunAt: nextCronOccurrence(everyFive, nowMs) },
        chainTargetId: "job-on-success",
      })
    })

    it("unretried failure routes to onFailureJobId", () => {
      expect(
        decide({ onSuccessJobId: "job-on-success", onFailureJobId: "job-on-failure" }),
      ).toEqual({
        _tag: "final",
        reschedule: { _tag: "cron", nextRunAt: nextCronOccurrence(everyFive, nowMs) },
        chainTargetId: "job-on-failure",
      })
    })

    it("success with no success target yields chainTargetId undefined", () => {
      expect(decide({ exitCode: 0, onFailureJobId: "job-on-failure" })).toEqual({
        _tag: "final",
        reschedule: { _tag: "cron", nextRunAt: nextCronOccurrence(everyFive, nowMs) },
        chainTargetId: undefined,
      })
    })

    it("failure with no failure target yields chainTargetId undefined", () => {
      expect(decide({ onSuccessJobId: "job-on-success" })).toEqual({
        _tag: "final",
        reschedule: { _tag: "cron", nextRunAt: nextCronOccurrence(everyFive, nowMs) },
        chainTargetId: undefined,
      })
    })
  })

  describe("schedule-origin reschedule", () => {
    it("a real cron reschedules to its next occurrence after nowMs", () => {
      expect(decide({ exitCode: 0 })).toEqual({
        _tag: "final",
        reschedule: { _tag: "cron", nextRunAt: nextCronOccurrence(everyFive, nowMs) },
        chainTargetId: undefined,
      })
    })

    it("an empty cron goes dormant", () => {
      expect(decide({ exitCode: 0, cronExpression: "" })).toEqual({
        _tag: "final",
        reschedule: { _tag: "dormant" },
        chainTargetId: undefined,
      })
    })

    it("a never-occurring cron is exhausted", () => {
      expect(decide({ exitCode: 0, cronExpression: impossibleCron })).toEqual({
        _tag: "final",
        reschedule: { _tag: "exhausted" },
        chainTargetId: undefined,
      })
    })
  })

  describe("manual/chain with no attempts used", () => {
    it("manual success with attemptsUsed 0 keeps the schedule untouched", () => {
      expect(decide({ exitCode: 0, origin: "manual" })).toEqual({
        _tag: "final",
        reschedule: { _tag: "keep" },
        chainTargetId: undefined,
      })
    })

    it("chain success with attemptsUsed 0 keeps the schedule untouched", () => {
      expect(decide({ exitCode: 0, origin: "chain" })).toEqual({
        _tag: "final",
        reschedule: { _tag: "keep" },
        chainTargetId: undefined,
      })
    })
  })

  describe("supersede rule: manual/chain with attemptsUsed > 0 never keep", () => {
    it("manual with attemptsUsed 1 and a real cron reschedules like a scheduled run", () => {
      expect(decide({ exitCode: 0, origin: "manual", attemptsUsed: 1 })).toEqual({
        _tag: "final",
        reschedule: { _tag: "cron", nextRunAt: nextCronOccurrence(everyFive, nowMs) },
        chainTargetId: undefined,
      })
    })

    it("chain with attemptsUsed 1 and an empty cron goes dormant instead of keeping", () => {
      expect(decide({ exitCode: 0, origin: "chain", attemptsUsed: 1, cronExpression: "" })).toEqual({
        _tag: "final",
        reschedule: { _tag: "dormant" },
        chainTargetId: undefined,
      })
    })
  })
})
