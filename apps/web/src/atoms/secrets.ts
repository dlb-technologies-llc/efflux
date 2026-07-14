import { PutSecretRequest } from "@efflux/shared"
import { Effect } from "effect"
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
