import { AgentApi } from "@effect-flue/shared"
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { HttpApiClient } from "effect/unstable/httpapi"
import * as Atom from "effect/unstable/reactivity/Atom"

/**
 * Service tag for the typed AgentApi HTTP client.
 *
 * Same-origin in production (relative URL ""); in development Vite proxies
 * `/agents/*` to the alchemy dev Worker on port 8787 — see `vite.config.ts`.
 */
export class ApiClient extends Context.Service<ApiClient, HttpApiClient.ForApi<typeof AgentApi>>()(
  "@effect-flue/web/ApiClient",
) {
  static readonly layer: Layer.Layer<ApiClient> = Layer.effect(
    ApiClient,
    HttpApiClient.make(AgentApi, {
      transformClient: (c) => c.pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl(""))),
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer))
}

/**
 * Layer-bound runtime — exposes `runtime.fn`, `runtime.atom`, and `runtime.pull`
 * for defining atoms that consume `ApiClient` (and any other services in this
 * layer's context).
 */
export const runtime = Atom.runtime(ApiClient.layer)

export { RegistryContext } from "@effect/atom-react"
