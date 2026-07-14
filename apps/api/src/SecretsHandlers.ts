import { AgentApi, SecretListResponse, SecretSummary } from "@efflux/shared"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { AgentStub } from "./AgentStub.ts"

/** Session-secret handlers for the `secrets` group: upsert/list write-only secrets on a session's `Agent` DO. Values never appear in any response — only names/timestamps are echoed back. */
export const SecretsHandlers = HttpApiBuilder.group(AgentApi, "secrets", (handlers) =>
  handlers
    .handle("putSecret", ({ params, payload }) =>
      Effect.gen(function* () {
        const agents = yield* AgentStub
        const agent = agents.getByName(`${params.name}/${params.id}`)
        yield* Effect.promise(() => agent.putSecret({ name: params.key, value: payload.value }))
        return new SecretSummary({ name: params.key, createdAt: Date.now() })
      }),
    )
    .handle("listSecrets", ({ params }) =>
      Effect.gen(function* () {
        const agents = yield* AgentStub
        const agent = agents.getByName(`${params.name}/${params.id}`)
        const secrets = yield* Effect.promise(() => agent.listSecretNames())
        return new SecretListResponse({ secrets: secrets.map((s) => new SecretSummary(s)) })
      }),
    ),
)
