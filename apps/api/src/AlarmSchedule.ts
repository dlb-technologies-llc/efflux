/**
 * Pure alarm-scheduling math for the Agent DO's single alarm slot: computing
 * the next daily-recurrence deadline and picking the soonest of a set of
 * deadlines to arm. No I/O and no DO state — kept standalone so it is
 * unit-testable without the DO runtime and so `Agent.ts` stays a thin caller.
 *
 * @module
 */

/** Next UTC epoch-ms occurrence of `hourUtc:minuteUtc`, strictly after `nowMs` (today if that time hasn't passed yet today, else tomorrow). */
export const nextDailyOccurrence = (hourUtc: number, minuteUtc: number, nowMs: number): number => {
  const d = new Date(nowMs)
  const candidate = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hourUtc, minuteUtc, 0, 0)
  return candidate > nowMs ? candidate : candidate + 24 * 60 * 60 * 1000
}

/** The soonest of a set of deadlines, or undefined for an empty set — the single DO alarm always arms to this. */
export const soonestDeadline = (deadlines: ReadonlyArray<number>): number | undefined =>
  deadlines.length === 0 ? undefined : Math.min(...deadlines)
