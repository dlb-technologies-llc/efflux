/**
 * Pins for `AlarmSchedule.ts` — the pure alarm-scheduling math shared by the
 * Agent DO's single alarm slot. Freezes `soonestDeadline`'s empty/single/tie
 * cases so a later change to the DO's alarm-arming logic cannot silently drift
 * when the alarm fires. (Per-schedule next-occurrence math is pinned separately
 * in `packages/shared/src/Cron.test.ts`.)
 *
 * @module
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { soonestDeadline } from "./AlarmSchedule.ts"

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
