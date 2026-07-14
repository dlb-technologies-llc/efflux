/**
 * Pins for `AlarmSchedule.ts` — the pure alarm-scheduling math shared by the
 * Agent DO's single alarm slot. Freezes `nextDailyOccurrence`'s boundary
 * (exactly-at, one-ms-before, one-ms-after the target time) and its behavior
 * across a UTC month/year rollover, plus `soonestDeadline`'s empty/single/tie
 * cases, so a later change to the DO's alarm-arming logic cannot silently
 * drift when the alarm fires.
 *
 * @module
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { nextDailyOccurrence, soonestDeadline } from "./AlarmSchedule.ts"

describe("nextDailyOccurrence", () => {
  const hourUtc = 10
  const minuteUtc = 30
  const candidate = Date.UTC(2026, 5, 15, hourUtc, minuteUtc, 0, 0)

  it.effect("now exactly at candidate -> rolls to tomorrow", () =>
    Effect.sync(() =>
      expect(nextDailyOccurrence(hourUtc, minuteUtc, candidate)).toBe(
        candidate + 24 * 60 * 60 * 1000,
      )))

  it.effect("now one ms before candidate -> today", () =>
    Effect.sync(() =>
      expect(nextDailyOccurrence(hourUtc, minuteUtc, candidate - 1)).toBe(candidate)))

  it.effect("now one ms after candidate -> rolls to tomorrow", () =>
    Effect.sync(() =>
      expect(nextDailyOccurrence(hourUtc, minuteUtc, candidate + 1)).toBe(
        candidate + 24 * 60 * 60 * 1000,
      )))

  it.effect("UTC month/year rollover: Dec 31 23:59:59.999 -> Jan 1 23:59:00.000", () =>
    Effect.sync(() => {
      const nowMs = Date.UTC(2025, 11, 31, 23, 59, 59, 999)
      const result = nextDailyOccurrence(23, 59, nowMs)
      expect(result).toBe(Date.UTC(2026, 0, 1, 23, 59, 0, 0))
    }))
})

describe("soonestDeadline", () => {
  it.effect("empty set -> undefined", () =>
    Effect.sync(() => expect(soonestDeadline([])).toBeUndefined()))

  it.effect("single deadline -> itself", () =>
    Effect.sync(() => expect(soonestDeadline([42])).toBe(42)))

  it.effect("multiple deadlines -> the minimum", () =>
    Effect.sync(() => expect(soonestDeadline([300, 100, 200])).toBe(100)))

  it.effect("ties -> the shared value", () =>
    Effect.sync(() => expect(soonestDeadline([50, 50, 50])).toBe(50)))
})
