import {
  AgentApi,
  ApprovalDecision,
  makePromptRequest,
  PromptRequest,
  StreamPart,
  streamAgentSse,
} from "@efflux/shared"
import type { PromptOverrides } from "@efflux/shared"
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
const encodeApprovalDecision = Schema.encodeSync(ApprovalDecision)

/** Typed AgentApi client, provided from the same FetchHttpClient the streaming path uses. */
class ApiClient extends Context.Service<ApiClient, HttpApiClient.ForApi<typeof AgentApi>>()(
  "@efflux/tui/ApiClient",
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
  const approveUrl = (name: string, id: string, eventId: number): string =>
    `${base}/agents/${encodeURIComponent(name)}/${encodeURIComponent(id)}/approve/${eventId}`
  return {
    runtime,
    history: (name: string, id: string) =>
      Effect.flatMap(ApiClient, (api) => api.agents.history({ params: { name, id } })),
    reset: (name: string, id: string) =>
      Effect.flatMap(ApiClient, (api) => api.agents.reset({ params: { name, id }, query: {} })),
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
    streamApprove: (
      name: string,
      id: string,
      eventId: number,
      decision: ApprovalDecision,
    ) =>
      Stream.unwrap(
        Effect.map(HttpClient.HttpClient, (http) =>
          streamAgentSse(
            http.post(approveUrl(name, id, eventId), {
              body: HttpBody.text(
                JSON.stringify(encodeApprovalDecision(decision)),
                "application/json",
              ),
            }),
            StreamPart,
          )),
      ),
  }
}

export type AgentClient = ReturnType<typeof makeAgentClient>
