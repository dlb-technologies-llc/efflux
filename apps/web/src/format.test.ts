/**
 * Ground-truth pins for the pure FE formatters in `./format.ts`.
 *
 * Each table freezes the EXACT string the formatter emits today, computed by
 * running the real implementation — not a re-derivation — so a future edit that
 * changes rendering (decimal places, the `k` abbreviation, the relative-time
 * buckets) breaks a pin instead of silently drifting the UI. `formatUsd`,
 * `formatTokens`, and `formatParams` are total pure functions, so their pins are
 * fully deterministic.
 *
 * `formatRelativeTime` reads `Date.now()` internally and takes no injectable
 * clock, so its cases are pinned MID-BUCKET: each offset sits well inside a
 * single label range (e.g. 5.5m for the "5m ago" bucket), leaving the few
 * milliseconds that elapse between building `epochMs` and the function's own
 * `Date.now()` call unable to cross a boundary. That keeps the exact strings
 * stable rather than flaky.
 *
 * Not covered here (not exported by `format.ts`, so out of scope for this file):
 * the timeline selectors `groupByTurn` / `turnTotals` live component-locally in
 * `components/JournalTimeline.tsx`, and `pendingApprovals` lives in
 * `atoms/journal.ts`.
 *
 * @module
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { formatParams, formatRelativeTime, formatTokens, formatUsd } from "./format.ts"

const usdCases: ReadonlyArray<readonly [number, string]> = [
  [0, "$0.0000"],
  [0.0001, "$0.0001"],
  [0.005, "$0.0050"],
  [0.0099, "$0.0099"],
  [0.01, "$0.01"],
  [0.124, "$0.12"],
  [0.126, "$0.13"],
  [0.999, "$1.00"],
  [1.5, "$1.50"],
  [1234.5, "$1234.50"],
]

const tokenCases: ReadonlyArray<readonly [number, string]> = [
  [0, "0"],
  [1, "1"],
  [999, "999"],
  [1000, "1.0k"],
  [1234, "1.2k"],
  [1500, "1.5k"],
  [999999, "1000.0k"],
  [1000000, "1000.0k"],
  [1234567, "1234.6k"],
]

const paramsCases: ReadonlyArray<readonly [unknown, string]> = [
  [{ command: "ls -la" }, `{"command":"ls -la"}`],
  [{ a: 1, b: true, c: null }, `{"a":1,"b":true,"c":null}`],
  [{ path: "/tmp", recursive: false }, `{"path":"/tmp","recursive":false}`],
  [[], "[]"],
  ["hello", `"hello"`],
  [42, "42"],
  [undefined, "undefined"],
]

const relativeOffsetCases: ReadonlyArray<readonly [number, string]> = [
  [0, "just now"],
  [30_000, "just now"],
  [330_000, "5m ago"],
  [3_570_000, "59m ago"],
  [9_000_000, "2h ago"],
  [84_600_000, "23h ago"],
  [475_200_000, "5d ago"],
]

describe("formatUsd", () => {
  for (const [cost, expected] of usdCases) {
    it.effect(`${cost} -> ${JSON.stringify(expected)}`, () =>
      Effect.sync(() => expect(formatUsd(cost)).toBe(expected)))
  }
})

describe("formatTokens", () => {
  for (const [count, expected] of tokenCases) {
    it.effect(`${count} -> ${JSON.stringify(expected)}`, () =>
      Effect.sync(() => expect(formatTokens(count)).toBe(expected)))
  }
})

describe("formatParams", () => {
  for (const [params, expected] of paramsCases) {
    it.effect(`${JSON.stringify(params) ?? String(params)} -> ${JSON.stringify(expected)}`, () =>
      Effect.sync(() => expect(formatParams(params)).toBe(expected)))
  }
})

describe("formatRelativeTime", () => {
  for (const [offsetMs, expected] of relativeOffsetCases) {
    it.effect(`${offsetMs}ms ago -> ${JSON.stringify(expected)}`, () =>
      Effect.sync(() => expect(formatRelativeTime(Date.now() - offsetMs)).toBe(expected)))
  }

  it.effect("labels stay ordered while the delta grows across buckets", () =>
    Effect.sync(() => {
      const now = Date.now()
      const labels = relativeOffsetCases.map(([offsetMs]) => formatRelativeTime(now - offsetMs))
      expect(labels).toEqual(["just now", "just now", "5m ago", "59m ago", "2h ago", "23h ago", "5d ago"])
    }))
})
