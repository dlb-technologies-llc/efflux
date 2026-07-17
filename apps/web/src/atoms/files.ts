import { Effect } from "effect"
import { ApiClient, runtime } from "../runtime.ts"
import type { SessionArgs } from "../session.ts"

/** Mutation fn: upload raw file bytes to the session workspace via `POST /agents/:name/:id/files?filename=`. */
export const uploadFileFn = runtime.fn(
  (args: SessionArgs & { readonly filename: string; readonly bytes: Uint8Array }) =>
    Effect.gen(function*() {
      const client = yield* ApiClient
      return yield* client.files.uploadFile({
        params: { name: args.name, id: args.id },
        query: { filename: args.filename },
        payload: args.bytes,
      })
    }),
)
