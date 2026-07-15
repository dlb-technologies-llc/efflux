import { Context, Effect, Layer } from "effect"
import type { AgentNamespace } from "./AgentStub.ts"

/** Per-request handle to the session's secret store — a Context.Service the secret tools depend on, provided per-turn from the resolved Agent stub (mirrors BashRunner/TodoStore). Never exposes a secret's raw VALUE — only presence (`has`) and names (`listNames`). */
export class SecretsStore extends Context.Service<SecretsStore, {
  readonly has: (name: string) => Effect.Effect<boolean>
  readonly listNames: Effect.Effect<ReadonlyArray<string>>
}>()("api/SecretsStore") {}

/** Bind a SecretsStore to one DO instance: `has`/`listNames` delegate straight to the Agent's `hasSecret`/`listSecretNames` RPCs. */
export const makeSecretsStoreLayer = (
  agent: ReturnType<AgentNamespace["getByName"]>,
): Layer.Layer<SecretsStore> =>
  Layer.succeed(
    SecretsStore,
    SecretsStore.of({
      has: (name) => Effect.promise(() => agent.hasSecret(name)),
      listNames: Effect.promise(() => agent.listSecretNames()).pipe(
        Effect.map((rows) => rows.map((r) => r.name)),
      ),
    }),
  )
