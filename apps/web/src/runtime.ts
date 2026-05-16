import { AgentApi } from "@effect-flue/shared"
import { Context as Context } from "effect"
import { Layer as Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { HttpApiClient } from "effect/unstable/httpapi"
import { Atom as Atom } from "effect/unstable/reactivity"

/**
 * Service tag for the typed AgentApi HTTP client.
 *
 * `baseUrl: window.location.origin` resolves to the Worker in production
 * (same Worker serves both `/` and `/agents/*`) and to Vite's dev server in
 * development — Vite's proxy forwards `/agents/*` to the local alchemy dev
 * Worker on port 8787 (see `vite.config.ts`).
 */
export class ApiClient extends Context.Service<ApiClient, HttpApiClient.ForApi<typeof AgentApi>>()(
  "@effect-flue/web/ApiClient",
) {
  static readonly layer: Layer.Layer<ApiClient> = Layer.effect(
    ApiClient,
    HttpApiClient.make(AgentApi, { baseUrl: window.location.origin }),
  ).pipe(Layer.provide(FetchHttpClient.layer))
}

/**
 * Layer-bound runtime — exposes `runtime.fn`, `runtime.atom`, and `runtime.pull`
 * for defining atoms that consume `ApiClient` (and any other services in this
 * layer's context).
 */
export const runtime = Atom.runtime(ApiClient.layer)

export { RegistryContext } from "@effect/atom-react"
