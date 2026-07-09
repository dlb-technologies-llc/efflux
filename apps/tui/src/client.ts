import {
  AgentApi,
  makePromptRequest,
  PromptRequest,
  StreamPart,
  streamAgentSse,
} from "@effect-flue/shared"
import type { PromptOverrides } from "@effect-flue/shared"
import { Context, Effect, Layer, ManagedRuntime, Schema, Stream } from "effect"
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientRequest,
} from "effect/unstable/http"
import { HttpApiClient } from "effect/unstable/httpapi"

export type { PromptOverrides }

const encodePromptRequest = Schema.encodeSync(PromptRequest)

/** Typed AgentApi client, provided from the same FetchHttpClient the streaming path uses. */
class ApiClient extends Context.Service<ApiClient, HttpApiClient.ForApi<typeof AgentApi>>()(
  "@effect-flue/tui/ApiClient",
) {}

/** FetchHttpClient with the bearer credential stamped on every outgoing request, so both the typed `AgentApi` client and the raw streaming `post` satisfy the Worker's bearer `AuthMiddleware`. */
const authedHttpClientLayer: Layer.Layer<HttpClient.HttpClient> = Layer.effect(
  HttpClient.HttpClient,
  Effect.map(
    HttpClient.HttpClient,
    HttpClient.mapRequest(
      HttpClientRequest.setHeader("Authorization", `Bearer ${process.env.API_TOKEN ?? ""}`),
    ),
  ),
).pipe(Layer.provide(FetchHttpClient.layer))

const clientLayer = (
  baseUrl: string,
): Layer.Layer<ApiClient | HttpClient.HttpClient> =>
  Layer.effect(ApiClient, HttpApiClient.make(AgentApi, { baseUrl })).pipe(
    Layer.provideMerge(authedHttpClientLayer),
  )

/** Effect-native client for one worker base URL: `history`/`reset` are Effects, `streamPrompt` a `Stream`; callers run them through `runtime` (disposing it interrupts in-flight work). */
export const makeAgentClient = (baseUrl: string) => {
  const base = baseUrl.replace(/\/$/, "")
  const runtime = ManagedRuntime.make(clientLayer(base))
  const streamUrl = (name: string, id: string): string =>
    `${base}/agents/${encodeURIComponent(name)}/${encodeURIComponent(id)}/stream`
  return {
    runtime,
    history: (name: string, id: string) =>
      Effect.flatMap(ApiClient, (api) => api.agents.history({ params: { name, id } })),
    reset: (name: string, id: string) =>
      Effect.flatMap(ApiClient, (api) => api.agents.reset({ params: { name, id } })),
    streamPrompt: (
      name: string,
      id: string,
      message: string,
      overrides: PromptOverrides,
    ) =>
      Stream.unwrap(
        Effect.map(HttpClient.HttpClient, (http) =>
          streamAgentSse(
            http.post(streamUrl(name, id), {
              body: HttpBody.text(
                JSON.stringify(encodePromptRequest(makePromptRequest(message, overrides))),
                "application/json",
              ),
            }),
            StreamPart,
          )),
      ),
  }
}

export type AgentClient = ReturnType<typeof makeAgentClient>
