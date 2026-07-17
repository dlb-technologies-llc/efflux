/**
 * Pins for the pure budget-accounting leaf (`Budget.ts`): the spend-delta
 * extraction from a hop's usage event, the running-total sum, and the
 * ceiling-crossing predicate. These freeze the `>=` boundary policy (equal
 * trips) and the `null`-ceiling-never-trips rule so a later wave wiring these
 * into the turn drivers cannot silently drift the budget decision.
 *
 * @module
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { addSpend, budgetExceeded, usageEventDelta, ZERO_SPEND } from "./Budget.ts"

describe("budgetExceeded", () => {
  it.effect("null/null caps never trip, even at large totals", () =>
    Effect.sync(() => {
      const caps = { maxTotalTokens: null, maxCostUsd: null }
      expect(budgetExceeded({ tokens: 0, cost: 0 }, caps)).toBe(false)
      expect(budgetExceeded({ tokens: 1_000_000, cost: 9999.99 }, caps)).toBe(false)
    }))

  it.effect("trips at EXACTLY the token cap (equal trips)", () =>
    Effect.sync(() => {
      const caps = { maxTotalTokens: 100, maxCostUsd: null }
      expect(budgetExceeded({ tokens: 99, cost: 0 }, caps)).toBe(false)
      expect(budgetExceeded({ tokens: 100, cost: 0 }, caps)).toBe(true)
      expect(budgetExceeded({ tokens: 101, cost: 0 }, caps)).toBe(true)
    }))

  it.effect("trips at EXACTLY the cost cap (equal trips)", () =>
    Effect.sync(() => {
      const caps = { maxTotalTokens: null, maxCostUsd: 1.5 }
      expect(budgetExceeded({ tokens: 0, cost: 1.49 }, caps)).toBe(false)
      expect(budgetExceeded({ tokens: 0, cost: 1.5 }, caps)).toBe(true)
      expect(budgetExceeded({ tokens: 0, cost: 1.51 }, caps)).toBe(true)
    }))

  it.effect("trips when the token dimension is over while cost is null", () =>
    Effect.sync(() =>
      expect(budgetExceeded({ tokens: 200, cost: 0 }, { maxTotalTokens: 100, maxCostUsd: null })).toBe(true)))

  it.effect("trips when the cost dimension is over while tokens is under", () =>
    Effect.sync(() =>
      expect(budgetExceeded({ tokens: 10, cost: 5 }, { maxTotalTokens: 100, maxCostUsd: 1 })).toBe(true)))

  it.effect("does NOT trip when both dimensions are strictly under", () =>
    Effect.sync(() =>
      expect(budgetExceeded({ tokens: 99, cost: 0.99 }, { maxTotalTokens: 100, maxCostUsd: 1 })).toBe(false)))
})

describe("usageEventDelta", () => {
  it.effect("undefined usage -> ZERO_SPEND", () =>
    Effect.sync(() => {
      expect(usageEventDelta(undefined)).toStrictEqual(ZERO_SPEND)
      expect(usageEventDelta(undefined)).toStrictEqual({ tokens: 0, cost: 0 })
    }))

  it.effect("prefers totalTokens when present", () =>
    Effect.sync(() =>
      expect(usageEventDelta({ inputTokens: 3, outputTokens: 4, totalTokens: 20, cost: 0.5 })).toStrictEqual({
        tokens: 20,
        cost: 0.5,
      })))

  it.effect("falls back to inputTokens + outputTokens when totalTokens is absent", () =>
    Effect.sync(() =>
      expect(usageEventDelta({ inputTokens: 3, outputTokens: 4, cost: 0.25 })).toStrictEqual({
        tokens: 7,
        cost: 0.25,
      })))

  it.effect("cost defaults to 0 when absent", () =>
    Effect.sync(() =>
      expect(usageEventDelta({ totalTokens: 12 })).toStrictEqual({ tokens: 12, cost: 0 })))
})

describe("addSpend", () => {
  it.effect("sums both fields", () =>
    Effect.sync(() =>
      expect(addSpend({ tokens: 5, cost: 1.25 }, { tokens: 7, cost: 0.75 })).toStrictEqual({
        tokens: 12,
        cost: 2,
      })))

  it.effect("ZERO_SPEND is the identity", () =>
    Effect.sync(() =>
      expect(addSpend(ZERO_SPEND, { tokens: 3, cost: 0.5 })).toStrictEqual({ tokens: 3, cost: 0.5 })))
})
