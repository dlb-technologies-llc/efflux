import { AgentApi, AgentError, messageOf, UploadResponse } from "@efflux/shared"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { AgentStub } from "./AgentStub.ts"

/** Handler for the `files` group: streams an uploaded file's bytes into the session's container `/workspace` via the Agent DO, which hydrates, writes, and snapshots to R2 before returning. */
export const FilesHandlers = HttpApiBuilder.group(AgentApi, "files", (handlers) =>
  handlers.handle("uploadFile", ({ params, query, payload }) =>
    Effect.gen(function* () {
      const agents = yield* AgentStub
      const agent = agents.getByName(`${params.name}/${params.id}`)
      const result = yield* Effect.tryPromise({
        try: () => agent.writeWorkspaceFile({ filename: query.filename, bytes: payload }),
        catch: (error) => new AgentError({ message: `upload failed: ${messageOf(error)}` }),
      })
      return new UploadResponse({ path: `/workspace/${query.filename}`, bytes: result.bytes })
    }),
  ),
)
