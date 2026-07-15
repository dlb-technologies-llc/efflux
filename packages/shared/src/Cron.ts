import { Schema } from "effect"

/** The expanded shape of a parsed 5-field cron expression: each time field as a sorted, de-duplicated set of matching integers, plus whether each day field was restricted (raw token other than `*`), which drives the Vixie OR-rule. */
export interface CronSpec {
  readonly minutes: ReadonlyArray<number>
  readonly hours: ReadonlyArray<number>
  readonly daysOfMonth: ReadonlyArray<number>
  readonly months: ReadonlyArray<number>
  readonly daysOfWeek: ReadonlyArray<number>
  readonly domRestricted: boolean
  readonly dowRestricted: boolean
}

const MACROS: Readonly<Record<string, string>> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
}

const DIGITS = /^\d+$/

const parseIntStrict = (token: string): number | undefined =>
  DIGITS.test(token) ? Number.parseInt(token, 10) : undefined

const rangeValues = (lo: number, hi: number, step: number): ReadonlyArray<number> => {
  const out: Array<number> = []
  for (let value = lo; value <= hi; value += step) out.push(value)
  return out
}

const parseRange = (
  token: string,
  min: number,
  max: number,
): { readonly lo: number; readonly hi: number } | undefined => {
  const dashIndex = token.indexOf("-")
  const hiToken = token.slice(dashIndex + 1)
  if (hiToken.includes("-")) return undefined
  const lo = parseIntStrict(token.slice(0, dashIndex))
  const hi = parseIntStrict(hiToken)
  if (lo === undefined || hi === undefined) return undefined
  if (lo < min || hi > max || lo > hi) return undefined
  return { lo, hi }
}

const parsePart = (part: string, min: number, max: number): ReadonlyArray<number> | undefined => {
  const slashIndex = part.indexOf("/")
  if (slashIndex === -1) {
    if (part === "*") return rangeValues(min, max, 1)
    if (part.includes("-")) {
      const bounds = parseRange(part, min, max)
      return bounds === undefined ? undefined : rangeValues(bounds.lo, bounds.hi, 1)
    }
    const value = parseIntStrict(part)
    if (value === undefined || value < min || value > max) return undefined
    return [value]
  }
  const stepToken = part.slice(slashIndex + 1)
  if (stepToken.includes("/")) return undefined
  const step = parseIntStrict(stepToken)
  if (step === undefined || step <= 0) return undefined
  const base = part.slice(0, slashIndex)
  if (base === "*") return rangeValues(min, max, step)
  if (base.includes("-")) {
    const bounds = parseRange(base, min, max)
    return bounds === undefined ? undefined : rangeValues(bounds.lo, bounds.hi, step)
  }
  return undefined
}

const normalizeDow = (value: number): number => (value === 7 ? 0 : value)

const parseField = (
  token: string | undefined,
  min: number,
  max: number,
  normalize?: (value: number) => number,
): ReadonlyArray<number> | undefined => {
  if (token === undefined || token.length === 0) return undefined
  const values = new Set<number>()
  for (const part of token.split(",")) {
    const parsed = parsePart(part, min, max)
    if (parsed === undefined) return undefined
    for (const value of parsed) values.add(normalize === undefined ? value : normalize(value))
  }
  return Array.from(values).sort((a, b) => a - b)
}

/**
 * Parse a 5-field UTC cron expression (or a supported `@macro`) into a {@link CronSpec},
 * or `undefined` when structurally invalid. Fields: `minute hour day-of-month month
 * day-of-week`, numeric only, each supporting `*`, lists (`a,b`), ranges (`a-b`), and
 * steps (`*` + `/n` or `a-b/n`). `day-of-week` accepts `0-7`; `7` normalises to `0`
 * (Sunday). `domRestricted`/`dowRestricted` record whether each day field's raw token was
 * anything other than `*`, driving the Vixie OR-rule in {@link nextCronOccurrence}. Macros:
 * `@hourly @daily @weekly @monthly @yearly @annually`. Inverted ranges such as `5-1` are
 * rejected as malformed.
 */
export const parseCron = (expr: string): CronSpec | undefined => {
  const trimmed = expr.trim()
  const expanded = MACROS[trimmed] ?? trimmed
  const fields = expanded.split(/\s+/).filter((field) => field.length > 0)
  if (fields.length !== 5) return undefined
  const [minuteToken, hourToken, domToken, monthToken, dowToken] = fields
  const minutes = parseField(minuteToken, 0, 59)
  const hours = parseField(hourToken, 0, 23)
  const daysOfMonth = parseField(domToken, 1, 31)
  const months = parseField(monthToken, 1, 12)
  const daysOfWeek = parseField(dowToken, 0, 7, normalizeDow)
  if (
    minutes === undefined ||
    hours === undefined ||
    daysOfMonth === undefined ||
    months === undefined ||
    daysOfWeek === undefined
  ) {
    return undefined
  }
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    domRestricted: domToken !== "*",
    dowRestricted: dowToken !== "*",
  }
}

const MINUTE = 60_000
const HORIZON_MS = 5 * 366 * 24 * 60 * MINUTE

const dayMatches = (spec: CronSpec, date: Date): boolean => {
  const domOk = spec.daysOfMonth.includes(date.getUTCDate())
  const dowOk = spec.daysOfWeek.includes(date.getUTCDay())
  if (spec.domRestricted && spec.dowRestricted) return domOk || dowOk
  if (spec.domRestricted) return domOk
  if (spec.dowRestricted) return dowOk
  return true
}

/**
 * Next UTC epoch-ms occurrence of `expr` strictly after `nowMs`, at minute granularity, or
 * `undefined` when the expression is invalid or has no occurrence within a ~5-year horizon
 * (an impossible date such as Feb 30). Vixie semantics: when BOTH day-of-month and
 * day-of-week are restricted, a day matches if EITHER matches; when exactly one is `*`, only
 * the other constrains the day.
 */
export const nextCronOccurrence = (expr: string, nowMs: number): number | undefined => {
  const spec = parseCron(expr)
  if (spec === undefined) return undefined
  const startT = Math.floor(nowMs / MINUTE) * MINUTE + MINUTE
  const limit = startT + HORIZON_MS
  let t = startT
  while (t <= limit) {
    const date = new Date(t)
    const year = date.getUTCFullYear()
    const monthIndex = date.getUTCMonth()
    const dayOfMonth = date.getUTCDate()
    const hour = date.getUTCHours()
    if (!spec.months.includes(monthIndex + 1)) {
      t = Date.UTC(year, monthIndex + 1, 1, 0, 0, 0, 0)
      continue
    }
    if (!dayMatches(spec, date)) {
      t = Date.UTC(year, monthIndex, dayOfMonth + 1, 0, 0, 0, 0)
      continue
    }
    if (!spec.hours.includes(hour)) {
      t = Date.UTC(year, monthIndex, dayOfMonth, hour + 1, 0, 0, 0)
      continue
    }
    if (!spec.minutes.includes(date.getUTCMinutes())) {
      t += MINUTE
      continue
    }
    return t
  }
  return undefined
}

/**
 * A validated cron expression: structurally parseable per {@link parseCron}. Existence of a
 * future occurrence (impossible dates) is enforced at job creation, not here, so this refine
 * stays pure and deterministic (no dependency on the current time).
 */
export const CronExpression = Schema.String.pipe(
  Schema.refine((s): s is string => parseCron(s) !== undefined, {
    title: "CronExpression",
    description:
      "5-field UTC cron (minute hour day-of-month month day-of-week) or @hourly/@daily/@weekly/@monthly/@yearly; supports *, lists, ranges, and /steps (numeric fields only)",
  }),
)
