import { ToolRule } from "@efflux/shared"
import { Effect } from "effect"
import { Atom } from "effect/unstable/reactivity"
import { ApiClient, runtime } from "../runtime.ts"
import type { SessionArgs } from "../session.ts"

/** Toolkit inventory atom: GET /meta/tools once and share the `ToolsResponse` across every subscriber. */
export const toolsAtom = runtime.atom(
  Effect.fnUntraced(function*() {
    const client = yield* ApiClient
    return yield* client.meta.tools()
  })(),
)

/**
 * Per-session effective config atom: GET /agents/:name/:id/config, memoised per
 * `{name, id}` via `Atom.family` so each session key reuses one atom and the
 * fetch fires on first subscribe. The Tools panel reads `rules` for its gate badges.
 */
export const sessionConfigAtom = Atom.family((args: SessionArgs) =>
  runtime.atom(
    Effect.fnUntraced(function*() {
      const client = yield* ApiClient
      return yield* client.agents.getConfig({ params: { name: args.name, id: args.id } })
    })(),
  ),
)

/** Mutation fn: flip one tool's session gate decision via `PUT /agents/:name/:id/config/rules/:tool`. */
export const setToolRuleFn = runtime.fn(
  (args: SessionArgs & { readonly tool: string; readonly rule: typeof ToolRule.Type }) =>
    Effect.gen(function*() {
      const client = yield* ApiClient
      return yield* client.agents.putToolRule({
        params: { name: args.name, id: args.id, tool: args.tool },
        payload: { rule: args.rule },
      })
    }),
)
