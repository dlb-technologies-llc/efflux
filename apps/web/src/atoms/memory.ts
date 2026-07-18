import { PutMemoryRequest } from "@efflux/shared"
import { Effect, Schema } from "effect"
import { Atom } from "effect/unstable/reactivity"
import { ApiClient, runtime } from "../runtime.ts"

const decodePutMemoryRequest = Schema.decodeUnknownEffect(PutMemoryRequest)

/**
 * Query atom (per-agent): load the agent's memory index (name + description +
 * updatedAt per fact) from `GET /memory/:agent`. `Atom.family` memoises per
 * agent name, so the fetch fires on first subscribe and a later
 * `useAtomRefresh(memoriesAtom(agent))` re-runs the same atom.
 */
export const memoriesAtom = Atom.family((agent: string) =>
  runtime.atom(
    Effect.fnUntraced(function*() {
      const client = yield* ApiClient
      return yield* client.memory.listMemories({ params: { agent } })
    })(),
  )
)

/**
 * Query atom (per `${agent}/${name}` composite key): load one full memory fact
 * from `GET /memory/:agent/:name`. `Atom.family` needs a primitive stable key,
 * so callers pass the composite string and it is split on the FIRST `/`
 * (memory names cannot contain `/`).
 */
export const memoryEntryAtom = Atom.family((key: string) =>
  runtime.atom(
    Effect.fnUntraced(function*() {
      const separator = key.indexOf("/")
      const agent = key.slice(0, separator)
      const name = key.slice(separator + 1)
      const client = yield* ApiClient
      return yield* client.memory.getMemory({ params: { agent, name } })
    })(),
  )
)

/**
 * Mutation fn: upsert a memory fact via `PUT /memory/:agent/:name`.
 * The payload MUST be a `PutMemoryRequest` INSTANCE — a shape-matching object
 * literal typechecks structurally but fails the client's request encoder at
 * runtime. It is produced by DECODING the raw form input (not `new ...`, whose
 * constructor THROWS on an over-cap value and surfaces as a defect instead of
 * an actionable failure the form can render).
 */
export const putMemoryFn = runtime.fn(
  (args: {
    readonly agent: string
    readonly name: string
    readonly description: string
    readonly content: string
  }) =>
    Effect.gen(function*() {
      const payload = yield* decodePutMemoryRequest({
        description: args.description,
        content: args.content,
      })
      const client = yield* ApiClient
      return yield* client.memory.putMemory({
        params: { agent: args.agent, name: args.name },
        payload,
      })
    })
)

/** Mutation fn: remove a memory fact via `DELETE /memory/:agent/:name`. */
export const deleteMemoryFn = runtime.fn(
  (args: { readonly agent: string; readonly name: string }) =>
    Effect.gen(function*() {
      const client = yield* ApiClient
      return yield* client.memory.deleteMemory({ params: { agent: args.agent, name: args.name } })
    })
)
