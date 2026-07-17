import { AgentApi, ArchiveListResponse } from "@efflux/shared"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { getArchive, listArchives } from "./ArchiveStore.ts"

/** Read-only archives handlers for the `archives` group: list the corpus index and read one archived session's full journal. `SessionsBucket` is provided at the Worker root, so nothing is provided here. */
export const ArchiveHandlers = HttpApiBuilder.group(AgentApi, "archives", (handlers) =>
  handlers
    .handle("listArchives", () =>
      Effect.gen(function* () {
        const archives = yield* listArchives()
        return new ArchiveListResponse({ archives })
      }),
    )
    .handle("getArchive", ({ params }) =>
      Effect.gen(function* () {
        return yield* getArchive(params.name, params.id, params.closedAt)
      }),
    ),
)
