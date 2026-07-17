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
 * Mutation fn: set or clear the session's token + cost budget. `putConfig`
 * replaces the session's overrides wholesale (there is no per-field config-merge
 * endpoint), so this first reads the effective config and re-sends every other
 * field unchanged, applying only the budget change. A `null` cap CLEARS that
 * ceiling by omitting the override key (the field is inherit-to-default, never
 * stored as null). Returns the new effective config.
 */
export const setBudgetFn = runtime.fn(
  (args: SessionArgs & { readonly maxTotalTokens: number | null; readonly maxCostUsd: number | null }) =>
    Effect.gen(function*() {
      const client = yield* ApiClient
      const resolved = yield* client.agents.getConfig({ params: { name: args.name, id: args.id } })
      return yield* client.agents.putConfig({
        params: { name: args.name, id: args.id },
        payload: {
          defaultModel: resolved.defaultModel,
          rules: resolved.rules,
          ttlSeconds: resolved.ttlSeconds,
          compactionThreshold: resolved.compactionThreshold,
          mcpServers: resolved.mcpServers,
          ...(args.maxTotalTokens !== null ? { maxTotalTokens: args.maxTotalTokens } : {}),
          ...(args.maxCostUsd !== null ? { maxCostUsd: args.maxCostUsd } : {}),
        },
      })
    }),
)
