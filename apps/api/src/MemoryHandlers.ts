import type { PlainMemoryEntry } from "@efflux/shared"
import {
  AgentApi,
  AgentError,
  MemoryEntry,
  MemoryLimitError,
  MemoryListResponse,
  MemoryNotFoundError,
  MemorySummary,
} from "@efflux/shared"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { MemoryStub } from "./Memory.ts"

/** Cross-session memory CRUD handlers for the `memory` group: list/read/upsert/delete facts on the per-agent-name `Memory` DO. The DO returns plain objects across the RPC fence, so every response rebuilds `Schema.Class` instances. `MemoryStub` is provided at the Worker root. */
export const MemoryHandlers = HttpApiBuilder.group(AgentApi, "memory", (handlers) =>
  handlers
    .handle("listMemories", ({ params }) =>
      Effect.gen(function* () {
        const ns = yield* MemoryStub
        const stub = ns.get(ns.idFromName(params.agent))
        const rows = yield* Effect.promise(() => stub.list())
        return new MemoryListResponse({ memories: rows.map((r) => new MemorySummary(r)) })
      }),
    )
    .handle("getMemory", ({ params }) =>
      Effect.gen(function* () {
        const ns = yield* MemoryStub
        const stub = ns.get(ns.idFromName(params.agent))
        const row = yield* Effect.promise<PlainMemoryEntry | null>(() => stub.read(params.name))
        if (row === null) {
          return yield* Effect.fail(new MemoryNotFoundError({ name: params.name }))
        }
        return new MemoryEntry(row)
      }),
    )
    .handle("putMemory", ({ params, payload }) =>
      Effect.gen(function* () {
        const ns = yield* MemoryStub
        const stub = ns.get(ns.idFromName(params.agent))
        const result = yield* Effect.promise(() =>
          stub.write({
            name: params.name,
            description: payload.description,
            content: payload.content,
          }),
        )
        if (result.saved === false) {
          return yield* Effect.fail(
            new MemoryLimitError({ message: result.error ?? "memory write rejected" }),
          )
        }
        if (result.entry === null) {
          return yield* Effect.fail(
            new AgentError({
              message: `memory write for "${params.name}" reported saved without an entry`,
            }),
          )
        }
        return new MemoryEntry(result.entry)
      }),
    )
    .handle("deleteMemory", ({ params }) =>
      Effect.gen(function* () {
        const ns = yield* MemoryStub
        const stub = ns.get(ns.idFromName(params.agent))
        const result = yield* Effect.promise(() => stub.remove(params.name))
        if (result.deleted === false) {
          return yield* Effect.fail(new MemoryNotFoundError({ name: params.name }))
        }
      }),
    ),
)
