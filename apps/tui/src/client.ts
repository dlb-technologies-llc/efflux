import type { HistoryResponse } from "@effect-flue/shared"
import { AgentApi, PromptRequest, StreamPart } from "@effect-flue/shared"
import { Effect, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { HttpApiClient } from "effect/unstable/httpapi"

const encodePromptRequest = Schema.encodeSync(PromptRequest)
const decodeStreamPart = Schema.decodeUnknownPromise(StreamPart)

/**
 * Per-session request overrides, settable via slash commands and CLI flags.
 * They ride on every subsequent PromptRequest.
 */
export interface PromptOverrides {
  readonly model?: string
  readonly skill?: string
  readonly role?: string
}

// HttpApiClient encodes payloads via the PromptRequest schema, which is a
// Schema.Class — it requires an actual class instance, not a plain object
// with the matching shape. See ISSUES.md.
const makePromptRequest = (message: string, overrides: PromptOverrides): PromptRequest =>
  new PromptRequest({
    message,
    ...(overrides.model !== undefined ? { model: overrides.model } : {}),
    ...(overrides.skill !== undefined ? { skill: overrides.skill } : {}),
    ...(overrides.role !== undefined ? { role: overrides.role } : {}),
  })

const parseSseEvent = (raw: string): unknown => {
  // SSE event blocks may contain multiple lines; only the `data:` lines carry payload.
  const dataLines: Array<string> = []
  for (const line of raw.split("\n")) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^\s/, ""))
    }
  }
  return JSON.parse(dataLines.join("\n"))
}

/**
 * Yields parsed `unknown` JSON payloads from an SSE response body, one per
 * `\n\n`-delimited event.
 *
 * Deliberately duplicated from apps/web/src/atoms.ts — the web copy sits
 * next to a load-bearing chunk-size invariant and the issue scopes this
 * change to apps/tui only. A later refactor can lift both into shared.
 */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        const trimmed = buffer.trim()
        if (trimmed.length > 0) {
          yield parseSseEvent(trimmed)
        }
        return
      }
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf("\n\n")
      while (boundary !== -1) {
        const event = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const trimmed = event.trim()
        if (trimmed.length > 0) {
          yield parseSseEvent(trimmed)
        }
        boundary = buffer.indexOf("\n\n")
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Open an SSE stream for one prompt turn and yield typed StreamParts.
 * Decode failures reject (never silently dropped); non-OK responses throw
 * with status + body text.
 */
export async function* streamPrompt(
  baseUrl: string,
  name: string,
  id: string,
  message: string,
  overrides: PromptOverrides,
): AsyncGenerator<StreamPart> {
  const body = encodePromptRequest(makePromptRequest(message, overrides))
  const response = await fetch(
    `${baseUrl}/agents/${encodeURIComponent(name)}/${encodeURIComponent(id)}/stream`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  )
  if (!response.ok || response.body === null) {
    const text = await response.text().catch(() => "")
    throw new Error(`Stream request failed: ${response.status} ${response.statusText} ${text}`.trim())
  }
  for await (const event of sseEvents(response.body)) {
    yield await decodeStreamPart(event)
  }
}

/**
 * Promise facade over the typed HttpApiClient for the non-streaming
 * endpoints. Built once at startup; call sites stay Effect-free.
 */
export interface AgentClient {
  readonly history: (name: string, id: string) => Promise<HistoryResponse>
  readonly reset: (name: string, id: string) => Promise<void>
  readonly streamPrompt: (
    name: string,
    id: string,
    message: string,
    overrides: PromptOverrides,
  ) => AsyncGenerator<StreamPart>
}

export const makeAgentClient = async (baseUrl: string): Promise<AgentClient> => {
  const base = baseUrl.replace(/\/$/, "")
  const api = await Effect.runPromise(
    HttpApiClient.make(AgentApi, { baseUrl: base }).pipe(
      Effect.provide(FetchHttpClient.layer),
    ),
  )
  return {
    history: (name, id) =>
      Effect.runPromise(api.agents.history({ params: { name, id } })),
    reset: (name, id) =>
      Effect.runPromise(api.agents.reset({ params: { name, id } })),
    streamPrompt: (name, id, message, overrides) => streamPrompt(base, name, id, message, overrides),
  }
}
