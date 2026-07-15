import { PutSecretRequest } from "@efflux/shared"
import { Effect } from "effect"
import { Atom } from "effect/unstable/reactivity"
import { ApiClient, runtime } from "../runtime.ts"
import type { SessionArgs } from "../session.ts"

/** Mutation fn: upsert a session secret via `PUT /agents/:name/:id/secrets/:key`. */
export const putSecretFn = runtime.fn(
  (args: SessionArgs & { readonly key: string; readonly value: string }) =>
    Effect.gen(function*() {
      const client = yield* ApiClient
      return yield* client.secrets.putSecret({
        params: { name: args.name, id: args.id, key: args.key },
        payload: new PutSecretRequest({ value: args.value }),
      })
    }),
)

/** Query atom (per-session): every stored secret name + creation time from `GET /agents/:name/:id/secrets`. Values are never returned — only names/timestamps. `Atom.family` memoises per `{name, id}`, so a later `useAtomRefresh(secretsAtom(session))` re-runs the same fetch. */
export const secretsAtom = Atom.family((args: SessionArgs) =>
  runtime.atom(
    Effect.fnUntraced(function*() {
      const client = yield* ApiClient
      return yield* client.secrets.listSecrets({ params: { name: args.name, id: args.id } })
    })(),
  )
)

/** Mutation fn: delete a stored secret via `DELETE /agents/:name/:id/secrets/:key`. */
export const deleteSecretFn = runtime.fn(
  (args: SessionArgs & { readonly key: string }) =>
    Effect.gen(function*() {
      const client = yield* ApiClient
      return yield* client.secrets.deleteSecret({
        params: { name: args.name, id: args.id, key: args.key },
      })
    }),
)
