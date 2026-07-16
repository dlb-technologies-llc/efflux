/**
 * Pins for `Cron.ts` — the pure UTC cron parser and next-occurrence math shared by
 * the scheduled-job dispatch path. Freezes step/range/list expansion, the Vixie
 * day-of-month/day-of-week OR-rule, day-of-week `7`→`0` normalisation, the
 * strictly-after boundary, month/year rollover, impossible-date and Feb-29 horizon
 * behaviour, macro expansion, and the `CronExpression` refine's accept/reject edge —
 * so later edits to dispatch scheduling cannot silently drift.
 *
 * @module
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Schema } from "effect"
import { CronExpression, nextCronOccurrence, parseCron } from "./Cron.ts"

describe("nextCronOccurrence step/range/list", () => {
  it.effect("*/10 -> next minute in {0,10,20,30,40,50} strictly after now", () =>
    Effect.sync(() =>
      expect(nextCronOccurrence("*/10 * * * *", Date.UTC(2026, 5, 15, 10, 3, 30, 0))).toBe(
        Date.UTC(2026, 5, 15, 10, 10, 0, 0),
      )))

  it.effect("0 * * * * -> next top-of-hour", () =>
    Effect.sync(() =>
      expect(nextCronOccurrence("0 * * * *", Date.UTC(2026, 5, 15, 10, 3, 30, 0))).toBe(
        Date.UTC(2026, 5, 15, 11, 0, 0, 0),
      )))

  it.effect("30 6 * * * -> next daily 06:30 rolls to tomorrow", () =>
    Effect.sync(() =>
      expect(nextCronOccurrence("30 6 * * *", Date.UTC(2026, 5, 15, 10, 0, 0, 0))).toBe(
        Date.UTC(2026, 5, 16, 6, 30, 0, 0),
      )))

  it.effect("0 9-17 * * * -> range hour, minute 0", () =>
    Effect.sync(() =>
      expect(nextCronOccurrence("0 9-17 * * *", Date.UTC(2026, 5, 15, 8, 30, 0, 0))).toBe(
        Date.UTC(2026, 5, 15, 9, 0, 0, 0),
      )))

  it.effect("0 0 1,15 * * -> list day-of-month", () =>
    Effect.sync(() =>
      expect(nextCronOccurrence("0 0 1,15 * *", Date.UTC(2026, 5, 10, 0, 0, 0, 0))).toBe(
        Date.UTC(2026, 5, 15, 0, 0, 0, 0),
      )))
})

describe("nextCronOccurrence Vixie day OR-semantics", () => {
  it.effect("0 0 13 * 5 -> next hit is a Friday that is NOT the 13th", () =>
    Effect.sync(() =>
      expect(nextCronOccurrence("0 0 13 * 5", Date.UTC(2026, 6, 1, 0, 0, 0, 0))).toBe(
        Date.UTC(2026, 6, 3, 0, 0, 0, 0),
      )))

  it.effect("0 0 13 * 5 -> next hit is the 13th (Saturday) that is NOT a Friday", () =>
    Effect.sync(() =>
      expect(nextCronOccurrence("0 0 13 * 5", Date.UTC(2026, 5, 12, 12, 0, 0, 0))).toBe(
        Date.UTC(2026, 5, 13, 0, 0, 0, 0),
      )))
})

describe("nextCronOccurrence day-of-week normalisation", () => {
  const now = Date.UTC(2026, 5, 15, 10, 0, 0, 0)

  it.effect("0 0 * * 7 behaves as Sunday (0 0 * * 0)", () =>
    Effect.sync(() => {
      const seven = nextCronOccurrence("0 0 * * 7", now)
      const zero = nextCronOccurrence("0 0 * * 0", now)
      expect(seven).toBe(zero)
      expect(seven).toBe(Date.UTC(2026, 5, 21, 0, 0, 0, 0))
    }))
})

describe("nextCronOccurrence boundaries and rollover", () => {
  it.effect("now exactly on a matching minute rolls to the NEXT occurrence", () =>
    Effect.sync(() =>
      expect(nextCronOccurrence("*/10 * * * *", Date.UTC(2026, 5, 15, 10, 10, 0, 0))).toBe(
        Date.UTC(2026, 5, 15, 10, 20, 0, 0),
      )))

  it.effect("Dec 31 -> Jan 1 next year (month/year rollover)", () =>
    Effect.sync(() =>
      expect(nextCronOccurrence("0 0 1 * *", Date.UTC(2026, 11, 31, 23, 59, 0, 0))).toBe(
        Date.UTC(2027, 0, 1, 0, 0, 0, 0),
      )))
})

describe("nextCronOccurrence impossible and leap dates", () => {
  it.effect("0 0 30 2 * -> undefined (Feb 30 never exists)", () =>
    Effect.sync(() =>
      expect(nextCronOccurrence("0 0 30 2 *", Date.UTC(2026, 5, 15, 0, 0, 0, 0))).toBeUndefined()))

  it.effect("0 0 29 2 * from a non-leap year -> next leap-year Feb 29", () =>
    Effect.sync(() =>
      expect(nextCronOccurrence("0 0 29 2 *", Date.UTC(2026, 5, 15, 0, 0, 0, 0))).toBe(
        Date.UTC(2028, 1, 29, 0, 0, 0, 0),
      )))
})

describe("parseCron rejects malformed expressions", () => {
  const invalid = [
    "* * * *",
    "* * * * * *",
    "60 * * * *",
    "* 24 * * *",
    "*/0 * * * *",
    "5-1 * * * *",
    "not a cron",
    "",
  ]
  invalid.forEach((expr) => {
    it.effect(`rejects ${JSON.stringify(expr)}`, () =>
      Effect.sync(() => expect(parseCron(expr)).toBeUndefined()))
  })
})

describe("parseCron accepts and normalises", () => {
  it.effect("day-of-week 7 normalises to 0", () =>
    Effect.sync(() => {
      const spec = parseCron("0 0 * * 7")
      expect(spec?.daysOfWeek).toStrictEqual([0])
      expect(spec?.dowRestricted).toBe(true)
    }))

  it.effect("day fields record restriction flags", () =>
    Effect.sync(() => {
      const spec = parseCron("*/10 * * * *")
      expect(spec?.minutes).toStrictEqual([0, 10, 20, 30, 40, 50])
      expect(spec?.domRestricted).toBe(false)
      expect(spec?.dowRestricted).toBe(false)
    }))
})

describe("parseCron macros", () => {
  const macros: ReadonlyArray<readonly [string, string]> = [
    ["@hourly", "0 * * * *"],
    ["@daily", "0 0 * * *"],
    ["@weekly", "0 0 * * 0"],
    ["@monthly", "0 0 1 * *"],
    ["@yearly", "0 0 1 1 *"],
    ["@annually", "0 0 1 1 *"],
  ]
  macros.forEach(([macro, expanded]) => {
    it.effect(`${macro} deep-equals ${expanded}`, () =>
      Effect.sync(() => expect(parseCron(macro)).toStrictEqual(parseCron(expanded))))
  })
})

describe("CronExpression refine", () => {
  it.effect("accepts a valid expression", () =>
    Effect.sync(() =>
      expect(Schema.decodeUnknownSync(CronExpression)("*/10 * * * *")).toBe("*/10 * * * *")))

  it.effect("rejects an invalid expression without throwing", () =>
    Effect.sync(() =>
      expect(Exit.isFailure(Schema.decodeUnknownExit(CronExpression)("60 * * * *"))).toBe(true)))
})

describe("Vixie OR-rule: a *-prefixed day field is unrestricted (AND), not OR", () => {
  it.effect("*/2 day-of-month is NOT restricted", () =>
    Effect.sync(() => expect(parseCron("0 9 */2 * 1-5")?.domRestricted).toBe(false)))

  it.effect("0 9 */2 * 1-5 fires weekdays-only: skips an odd-dated Saturday to the next weekday", () =>
    Effect.sync(() =>
      expect(nextCronOccurrence("0 9 */2 * 1-5", Date.UTC(2026, 0, 3, 8, 0, 0, 0))).toBe(
        Date.UTC(2026, 0, 5, 9, 0, 0, 0),
      )))

  it.effect("both restricted (13th OR Friday) still ORs", () =>
    Effect.sync(() => {
      const spec = parseCron("0 0 13 * 5")
      expect(spec?.domRestricted).toBe(true)
      expect(spec?.dowRestricted).toBe(true)
    }))
})

describe("parseCron is total for Object.prototype member names (no throw)", () => {
  const prototypeNames = ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf"]
  prototypeNames.forEach((name) => {
    it.effect(`${name} -> undefined, never throws`, () =>
      Effect.sync(() => expect(parseCron(name)).toBeUndefined()))
    it.effect(`CronExpression rejects ${name} without throwing`, () =>
      Effect.sync(() => expect(Exit.isFailure(Schema.decodeUnknownExit(CronExpression)(name))).toBe(true)))
  })
})
