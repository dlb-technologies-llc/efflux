/**
 * Self-contained Worker-side web_fetch HTTP client: SSRF-guarded URL validation,
 * manual redirect following with per-hop host re-validation, and a byte/char-capped
 * body read. Returns a WebFetchResult; every failure surfaces in-band as status 0.
 */
import { Cause, Effect, Schema } from "effect"
import { isBlockedHost } from "./Ssrf.ts"
import { MAX_TOOL_OUTPUT_CHARS } from "./Truncate.ts"

/** Network read ceiling; the returned body is further capped for the prompt. */
export const MAX_FETCH_BYTES = 100_000

/** How many redirect hops to follow before giving up (re-validated on each). */
export const MAX_REDIRECT_HOPS = 5

/** Shape returned by runWebFetch: the response status/content-type, the (capped) body, and whether it was cut. */
export const WebFetchResult = Schema.Struct({
  status: Schema.Number,
  contentType: Schema.String,
  body: Schema.String,
  truncated: Schema.Boolean,
})

type WebFetchResultValue = typeof WebFetchResult.Type

/** In-band failure result (status 0) carrying the reason in the body for the model to read. */
export const webFetchError = (message: string): WebFetchResultValue => ({
  status: 0,
  contentType: "",
  body: `Error: ${message}`,
  truncated: false,
})

/** Surface the first failure/defect in a cause as readable text for the model. */
export const causeMessage = (cause: Cause.Cause<unknown>): string => {
  for (const reason of cause.reasons) {
    const value = Cause.isFailReason(reason)
      ? reason.error
      : Cause.isDieReason(reason)
        ? reason.defect
        : undefined
    if (value instanceof Error) return value.message
    if (value !== undefined) return String(value)
  }
  return "unknown error"
}

/** Read the response body up to MAX_FETCH_BYTES; cancels the reader on early exit and streams decode so a byte cut can't split a multibyte char. */
const readBody = (
  response: Response,
): Effect.Effect<{ text: string; truncated: boolean }, Cause.UnknownError> =>
  Effect.tryPromise(async (signal) => {
    const body = response.body
    if (body === null) return { text: "", truncated: false }
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let text = ""
    let bytes = 0
    let truncated = false
    while (true) {
      if (signal.aborted) {
        await reader.cancel()
        throw new Error("fetch aborted")
      }
      const { done, value } = await reader.read()
      if (done || value === undefined) break
      bytes += value.byteLength
      text += decoder.decode(value, { stream: true })
      if (bytes >= MAX_FETCH_BYTES) {
        truncated = true
        await reader.cancel()
        break
      }
    }
    text += decoder.decode()
    return { text, truncated }
  })

/** Follow redirects manually, re-validating each hop's host and draining intermediate 3xx bodies; the AbortSignal wiring is load-bearing or the 15s timeout leaves the subrequest dangling. */
const followRedirects = (
  target: URL,
  hopsLeft: number,
): Effect.Effect<Response, Cause.UnknownError | Error> =>
  Effect.gen(function* () {
    const res = yield* Effect.tryPromise((signal) =>
      fetch(target.href, { redirect: "manual", signal }),
    )
    const location =
      res.status >= 300 && res.status < 400 ? res.headers.get("location") : null
    if (location === null) return res
    yield* Effect.promise(() => res.body?.cancel() ?? Promise.resolve())
    if (hopsLeft === 0) {
      return yield* Effect.fail(
        new Error(`too many redirects (>${MAX_REDIRECT_HOPS})`),
      )
    }
    const next = yield* Effect.try(() => new URL(location, target)).pipe(
      Effect.mapError(() => new Error(`invalid redirect target: ${location}`)),
    )
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      return yield* Effect.fail(
        new Error(`redirect to unsupported scheme: ${next.protocol}`),
      )
    }
    if (isBlockedHost(next.hostname)) {
      return yield* Effect.fail(
        new Error(
          `redirect to blocked host: ${next.hostname} (private/internal address)`,
        ),
      )
    }
    return yield* followRedirects(next, hopsLeft - 1)
  })

/** Fetch a public http(s) URL with SSRF guarding, manual redirect handling, and a 15s timeout; all failures collapse to a status-0 WebFetchResult. */
export const runWebFetch = (url: string): Effect.Effect<WebFetchResultValue> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try(() => new URL(url))
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return yield* Effect.fail(
        new Error(`unsupported URL scheme: ${parsed.protocol} (only http/https)`),
      )
    }
    if (isBlockedHost(parsed.hostname)) {
      return yield* Effect.fail(
        new Error(`blocked host: ${parsed.hostname} (private/internal address)`),
      )
    }
    const response = yield* followRedirects(parsed, MAX_REDIRECT_HOPS)
    const { text, truncated } = yield* readBody(response)
    const capped = text.length > MAX_TOOL_OUTPUT_CHARS
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      body: capped
        ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n[body truncated]`
        : text,
      truncated: truncated || capped,
    }
  }).pipe(
    Effect.timeout("15 seconds"),
    Effect.catchCause((cause) =>
      Effect.succeed(webFetchError(causeMessage(cause))),
    ),
  )
