/**
 * Pure alarm-scheduling math for the Agent DO's single alarm slot: picking the
 * soonest of a set of deadlines to arm. No I/O and no DO state — kept standalone
 * so it is unit-testable without the DO runtime and so `Agent.ts` stays a thin
 * caller. Per-schedule next-occurrence math now lives in `@efflux/shared`'s
 * `Cron.ts` (`nextCronOccurrence`).
 *
 * @module
 */

/** The soonest of a set of deadlines, or undefined for an empty set — the single DO alarm always arms to this. */
export const soonestDeadline = (deadlines: ReadonlyArray<number>): number | undefined =>
  deadlines.length === 0 ? undefined : Math.min(...deadlines)
