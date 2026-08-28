/**
 * Pure budget-accounting leaf for per-session token+cost spend ceilings.
 *
 * This module has ZERO repo dependencies on purpose: it is the shared leaf that
 * both the turn drivers (`AgentLoop.ts`) and the journal writer (`JournalWrite.ts`)
 * depend on. Because `AgentLoop.ts` already imports `JournalWrite.ts`, putting the
 * spend helpers here (rather than in either of those) avoids the
 * `AgentLoop.ts` <-> `JournalWrite.ts` import cycle. Keep it a pure leaf: types
 * plus total, side-effect-free predicates, no imports.
 *
 * @module
 */

/** A session's resolved spend ceilings; `null` on a field means that dimension is unlimited. */
export interface SpendCaps {
  readonly maxTotalTokens: number | null
  readonly maxCostUsd: number | null
}

/** Cumulative spend: total tokens and total USD cost. */
export interface SpendTotals {
  readonly tokens: number
  readonly cost: number
}

/** The zero point for accumulating a turn's hops. */
export const ZERO_SPEND: SpendTotals = { tokens: 0, cost: 0 }

/** One hop's spend delta from its `usage` event (or `undefined` when the hop recorded none). Prefer `totalTokens`, else `inputTokens + outputTokens`; cost defaults to 0. This in-turn running total agrees with `Agent.usageTotals()`'s cross-turn `SUM(inputTokens)+SUM(outputTokens)` ONLY because `buildUsageEvent` sets `totalTokens` exactly to `inputTokens + outputTokens` (never a provider-native total) — keep that invariant if either side changes, or the pre-turn seed and the running total silently diverge. */
export const usageEventDelta = (
  usage:
    | {
        readonly inputTokens?: number
        readonly outputTokens?: number
        readonly totalTokens?: number
        readonly cost?: number
      }
    | undefined,
): SpendTotals =>
  usage === undefined
    ? ZERO_SPEND
    : {
        tokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
        cost: usage.cost ?? 0,
      }

/** Sum two spend totals. */
export const addSpend = (a: SpendTotals, b: SpendTotals): SpendTotals => ({
  tokens: a.tokens + b.tokens,
  cost: a.cost + b.cost,
})

/** True when cumulative spend has reached or crossed either configured ceiling; a `null` ceiling never trips. */
export const budgetExceeded = (totals: SpendTotals, caps: SpendCaps): boolean =>
  (caps.maxTotalTokens !== null && totals.tokens >= caps.maxTotalTokens) ||
  (caps.maxCostUsd !== null && totals.cost >= caps.maxCostUsd)

/** Project a resolved config's ceilings into `SpendCaps` — one place so every driver/handler reads caps identically. */
export const capsFromConfig = (config: {
  readonly maxTotalTokens: number | null
  readonly maxCostUsd: number | null
}): SpendCaps => ({ maxTotalTokens: config.maxTotalTokens, maxCostUsd: config.maxCostUsd })
