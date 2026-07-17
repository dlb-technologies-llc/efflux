import { Effect } from "effect"
import { Atom } from "effect/unstable/reactivity"
import { ApiClient, runtime } from "../runtime.ts"
import type { SessionArgs } from "../session.ts"

/**
 * Per-session spend atom: GET /agents/:name/:id/usage, memoised per `{name, id}`
 * via `Atom.family` so each session key reuses one atom and the fetch fires on
 * first subscribe. Carries cumulative tokens/cost, the resolved caps, and whether
 * either ceiling is tripped — the Budget panel reads all of it.
 */
export const sessionUsageAtom = Atom.family((args: SessionArgs) =>
  runtime.atom(
    Effect.fnUntraced(function*() {
      const client = yield* ApiClient
      return yield* client.agents.usage({ params: { name: args.name, id: args.id } })
    })(),
  ),
)

/**
 * Mutation fn: set or clear the session's token + cost budget via the dedicated
 * `PUT /config/budget` endpoint, which merges the change into the stored
 * overrides server-side (preserving every other field) and validates the caps
 * against `SetBudgetRequest`. A `null` field CLEARS that cap. Returns the new
 * effective config.
 */
export const setBudgetFn = runtime.fn(
  (args: SessionArgs & { readonly maxTotalTokens: number | null; readonly maxCostUsd: number | null }) =>
    Effect.gen(function*() {
      const client = yield* ApiClient
      return yield* client.agents.putBudget({
        params: { name: args.name, id: args.id },
        payload: { maxTotalTokens: args.maxTotalTokens, maxCostUsd: args.maxCostUsd },
      })
    }),
)
