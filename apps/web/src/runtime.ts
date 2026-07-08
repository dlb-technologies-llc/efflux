import { AgentApi } from "@effect-flue/shared"
import { Context, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { HttpApiClient } from "effect/unstable/httpapi"
import { Atom } from "effect/unstable/reactivity"

/**
 * Service tag for the typed AgentApi HTTP client.
 *
 * `baseUrl: window.location.origin` resolves to the Worker in production
 * (same Worker serves both `/` and `/agents/*`) and to Vite's dev server in
 * development — Vite's proxy forwards `/agents/*` to the local `wrangler dev`
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
 * for defining atoms that consume `ApiClient` OR the bare `HttpClient` (used by
 * the streaming atom to POST and hand the response to `streamAgentSse`). Both
 * services share the one `FetchHttpClient`.
 */
export const runtime = Atom.runtime(
  Layer.mergeAll(ApiClient.layer, FetchHttpClient.layer),
)
