import { AgentApi } from "@efflux/shared"
import { Context, Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { HttpApiClient } from "effect/unstable/httpapi"
import { Atom } from "effect/unstable/reactivity"

/**
 * Bare `HttpClient` that stamps `Authorization: Bearer <VITE_API_TOKEN>` onto
 * every outgoing request, provided over `FetchHttpClient.layer`.
 *
 * This is the single source of the authed transport: both the typed
 * {@link ApiClient} and the bare `HttpClient.HttpClient` the streaming atoms
 * resolve are built from it, so the two HTTP paths cannot drift on auth — the
 * FE's send-message and approve flows both carry the header.
 *
 * `VITE_API_TOKEN` is inlined into the public bundle at build time, so it is
 * demo-grade: ~zero protection against a browser user who reads the source —
 * it only gates non-browser abuse of the deployed Worker.
 */
const AuthedHttpClient: Layer.Layer<HttpClient.HttpClient> = Layer.effect(
  HttpClient.HttpClient,
  Effect.map(
    HttpClient.HttpClient,
    HttpClient.mapRequest(
      HttpClientRequest.setHeader(
        "Authorization",
        `Bearer ${import.meta.env.VITE_API_TOKEN ?? ""}`,
      ),
    ),
  ),
).pipe(Layer.provide(FetchHttpClient.layer))

/**
 * Service tag for the typed AgentApi HTTP client.
 *
 * `baseUrl: window.location.origin` resolves to the Worker in production
 * (same Worker serves both `/` and `/agents/*`) and to Vite's dev server in
 * development — Vite's proxy forwards `/agents/*` to the local `wrangler dev`
 * Worker on port 8787 (see `vite.config.ts`).
 */
export class ApiClient extends Context.Service<ApiClient, HttpApiClient.ForApi<typeof AgentApi>>()(
  "@efflux/web/ApiClient",
) {
  static readonly layer: Layer.Layer<ApiClient> = Layer.effect(
    ApiClient,
    HttpApiClient.make(AgentApi, { baseUrl: window.location.origin }),
  ).pipe(Layer.provide(AuthedHttpClient))
}

/**
 * Layer-bound runtime — exposes `runtime.fn`, `runtime.atom`, and `runtime.pull`
 * for defining atoms that consume `ApiClient` OR the bare `HttpClient` (used by
 * the streaming atom to POST and hand the response to `streamAgentSse`). Both
 * services share the one authed `HttpClient`, so every request carries the token.
 */
export const runtime = Atom.runtime(
  Layer.mergeAll(ApiClient.layer, AuthedHttpClient),
)
