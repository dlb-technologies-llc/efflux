/**
 * Hand-rolled MCP client over the Streamable-HTTP transport (JSON-RPC 2.0).
 *
 * Effect ships an `McpServer` but no client, so this is request/response only:
 * `connect` runs the `initialize` → `notifications/initialized` handshake and
 * returns a client holding the negotiated protocol version plus any
 * `Mcp-Session-Id`; `listTools`/`callTool` reuse them. One connected client per
 * (server, turn). No long-lived listener, resources/prompts/sampling, or auth.
 */
import type { McpServer } from "@efflux/shared"
import { Data, Effect, Predicate, Schema } from "effect"
import { McpSchema } from "effect/unstable/ai"
import { isBlockedHost } from "./Ssrf.ts"

/** Protocol version this client requests; the server MAY negotiate a different one, which we then echo back. */
const PROTOCOL_VERSION = "2025-06-18"

/** Client identity sent in the `initialize` handshake. */
const CLIENT_INFO = { name: "efflux", version: "0.1.0" }

/** Rendered in place of image/audio/other non-text content blocks when flattening a tool result. */
const NON_TEXT_PLACEHOLDER = "[non-text content omitted]"

/** Maximum redirect hops followed while re-validating each hop's host against the SSRF blocklist BEFORE re-posting to it. */
const MAX_REDIRECT_HOPS = 5

/** The client's own typed failure. Distinct from `McpSchema.McpError`, which is the wire error decoded INTO `.message`. */
export class McpError extends Data.TaggedError("McpError")<{
  readonly server: string
  readonly message: string
}> {}

/** A tool discovered via `tools/list`; `inputSchema` is the server's raw JSON Schema, passed through untouched. */
export interface McpToolDef {
  readonly name: string
  readonly description: string | undefined
  readonly inputSchema: unknown
}

/** A `tools/call` outcome flattened to text; `isError` reflects the result's `isError` flag. */
export interface McpCallResult {
  readonly text: string
  readonly isError: boolean
}

/** A connected client bound to one server for the lifetime of a turn. */
export interface McpClient {
  readonly listTools: Effect.Effect<ReadonlyArray<McpToolDef>, McpError>
  readonly callTool: (name: string, args: unknown) => Effect.Effect<McpCallResult, McpError>
}

const decodeInitializeResult = Schema.decodeUnknownEffect(McpSchema.InitializeResult)
const decodeListToolsResult = Schema.decodeUnknownEffect(McpSchema.ListToolsResult)
const decodeCallToolResult = Schema.decodeUnknownEffect(McpSchema.CallToolResult)

/** Human-readable rendering of an unknown thrown value for an error message. */
const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** Clamp text to `max` characters so an error body can't dominate the message. */
const truncate = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}...` : text

/** Read a property off a value that may not be an object, without a cast; absent/non-object yields `undefined`. */
const readField = (value: unknown, key: string): unknown =>
  Predicate.isObject(value) ? value[key] : undefined

/** Parse a JSON string; typed `unknown` so `JSON.parse`'s `any` never leaks. */
const parseJson = (text: string): unknown => JSON.parse(text)

/**
 * Parse one already-framed SSE `data:` payload, skipping non-JSON frames.
 *
 * SSE channels may carry comments or keep-alive frames that are not JSON; a
 * frame that does not parse is not the reply we are matching on, so it is
 * skipped (not an error to surface).
 */
const tryParseJson = (text: string): unknown => {
  try {
    return parseJson(text)
  } catch {
    return undefined
  }
}

/** Extract a readable message from a JSON-RPC `error` object, falling back to its serialized form. */
const jsonRpcErrorMessage = (error: unknown): string => {
  if (Predicate.isObject(error)) {
    const message = error["message"]
    const code = error["code"]
    const suffix = typeof code === "number" ? ` (code ${code})` : ""
    if (typeof message === "string") return `${message}${suffix}`
  }
  return `JSON-RPC error: ${truncate(JSON.stringify(error), 300)}`
}

/** Hostname of a (possibly post-redirect) response URL, or undefined when it can't be parsed. */
const responseHost = (rawUrl: string): string | undefined => {
  try {
    return new URL(rawUrl).hostname
  } catch {
    return undefined
  }
}

/**
 * POST a JSON-RPC body to `url`, following any 3xx redirect MANUALLY and
 * re-validating each hop's host against the SSRF blocklist BEFORE re-posting to
 * it. `redirect: "manual"` stops fetch from replaying the body to the redirect
 * target on its own, so an allowlist-passing public server cannot bounce the
 * POST to an internal host (e.g. `308 → http://169.254.169.254/`). Fails closed
 * with an `McpError` on a network failure, a missing/malformed `Location`, a
 * blocked host, or an exceeded hop cap.
 */
const postFollowingRedirects = (
  server: McpServer,
  url: string,
  headers: Record<string, string>,
  body: string,
  hopsLeft: number,
): Effect.Effect<Response, McpError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            ...headers,
          },
          body,
          redirect: "manual",
          signal,
        }),
      catch: (error) =>
        new McpError({ server: server.name, message: `request failed: ${describe(error)}` }),
    })
    const location =
      response.status >= 300 && response.status < 400 ? response.headers.get("location") : null
    if (location === null) return response
    yield* Effect.ignore(Effect.tryPromise(() => response.body?.cancel() ?? Promise.resolve()))
    if (hopsLeft === 0) {
      return yield* Effect.fail(
        new McpError({ server: server.name, message: `too many redirects (>${MAX_REDIRECT_HOPS})` }),
      )
    }
    const next = yield* Effect.try(() => new URL(location, url)).pipe(
      Effect.mapError(
        () =>
          new McpError({ server: server.name, message: `invalid redirect target: ${location}` }),
      ),
    )
    if (isBlockedHost(next.hostname)) {
      return yield* Effect.fail(
        new McpError({
          server: server.name,
          message: `redirect to blocked host: ${next.hostname} (private/internal address)`,
        }),
      )
    }
    return yield* postFollowingRedirects(server, next.href, headers, body, hopsLeft - 1)
  })

/** POST a JSON-RPC payload with SSRF-safe manual redirect following; a network/fetch failure or blocked redirect becomes an `McpError`. */
const sendFetch = (
  server: McpServer,
  headers: Record<string, string>,
  payload: unknown,
): Effect.Effect<Response, McpError> =>
  postFollowingRedirects(server, server.url, headers, JSON.stringify(payload), MAX_REDIRECT_HOPS).pipe(
    Effect.flatMap((response) => {
      const host = responseHost(response.url)
      return host !== undefined && isBlockedHost(host)
        ? Effect.fail(
            new McpError({
              server: server.name,
              message: `response host blocked after redirect: ${host} (private/internal address)`,
            }),
          )
        : Effect.succeed(response)
    }),
  )

/** Fail with an `McpError` carrying status + body text on a non-2xx response; otherwise pass the response through. */
const ensureOk = (server: McpServer, response: Response): Effect.Effect<Response, McpError> =>
  response.ok
    ? Effect.succeed(response)
    : Effect.promise(() => response.text().then((body) => body, () => "")).pipe(
        Effect.flatMap((body) =>
          Effect.fail(
            new McpError({
              server: server.name,
              message: `HTTP ${response.status} ${response.statusText}: ${truncate(body, 500)}`,
            }),
          ),
        ),
      )

/** Read a whole-body JSON reply. */
const readJsonReply = (server: McpServer, response: Response): Effect.Effect<unknown, McpError> =>
  Effect.tryPromise({
    try: () => response.text(),
    catch: (error) =>
      new McpError({ server: server.name, message: `failed to read response body: ${describe(error)}` }),
  }).pipe(
    Effect.flatMap((text) =>
      Effect.try({
        try: () => parseJson(text),
        catch: () =>
          new McpError({
            server: server.name,
            message: `response body was not valid JSON: ${truncate(text, 200)}`,
          }),
      }),
    ),
  )

/** Strip one trailing carriage return so a line parses identically under `\r\n` and `\n` endings. */
const stripCr = (line: string): string => (line.endsWith("\r") ? line.slice(0, -1) : line)

/** The value carried by one `data:` line: the text after `data:`, with a single optional leading space removed. */
const dataLineValue = (line: string): string => line.slice(5).replace(/^ /, "")

/** Join one SSE event's lines into its `data:` payload (data-line values by `\n`), dropping non-`data:` lines; `undefined` when the event carries no `data:` line. */
const framePayload = (lines: ReadonlyArray<string>): string | undefined => {
  const data = lines.filter((line) => line.startsWith("data:")).map(dataLineValue)
  return data.length === 0 ? undefined : data.join("\n")
}

/** Complete SSE frames split out of an accumulated buffer, plus the still-incomplete trailing `rest` to prepend to the next chunk. */
export interface SseFrames {
  readonly frames: ReadonlyArray<string>
  readonly rest: string
}

/**
 * Split accumulated SSE text into complete event frames plus the unparsed tail.
 *
 * Pure and streaming-safe: an event is complete only once a blank line
 * terminates it (`\r\n` tolerated), so each returned frame is that event's
 * `data:` payload with non-`data:` lines (comments/keep-alives, `event:`, `id:`)
 * dropped and events carrying no `data:` line omitted. `rest` is the bytes from
 * the first still-incomplete event onward — feed it back joined to the next
 * chunk so a frame split across reads is not lost.
 */
export const parseSseFrames = (buffer: string): SseFrames => {
  const frames: Array<string> = []
  let pending: Array<string> = []
  let eventStart = 0
  let lineStart = 0
  let newline = buffer.indexOf("\n")
  while (newline !== -1) {
    const line = stripCr(buffer.slice(lineStart, newline))
    if (line === "") {
      const payload = framePayload(pending)
      if (payload !== undefined) frames.push(payload)
      pending = []
      eventStart = newline + 1
    } else {
      pending.push(line)
    }
    lineStart = newline + 1
    newline = buffer.indexOf("\n", lineStart)
  }
  return { frames, rest: buffer.slice(eventStart) }
}

/** Flush the final unterminated event at stream end: the `rest` buffer's `data:` payload, or `undefined` when it carries no `data:` line. */
export const flushSseFrame = (rest: string): string | undefined =>
  framePayload(rest.split("\n").map(stripCr))

/** First SSE frame that parses to a JSON-RPC message with the given `id`, or `undefined`; non-JSON frames (keep-alives) are skipped. */
export const matchFrameById = (frames: Iterable<string>, id: number): unknown => {
  for (const frame of frames) {
    const parsed = tryParseJson(frame)
    if (readField(parsed, "id") === id) return parsed
  }
  return undefined
}

/**
 * Stream an SSE reply and return the JSON-RPC message whose `id` matches, then
 * cancel the reader. Stops at the first match rather than draining, so a server
 * that holds the channel open after replying does not hang to the timeout. Frame
 * extraction and id-matching live in the pure `parseSseFrames` / `flushSseFrame`
 * / `matchFrameById` helpers; only the read/cancel loop here is effectful.
 */
const readSseReply = (
  server: McpServer,
  response: Response,
  id: number,
): Effect.Effect<unknown, McpError> =>
  Effect.tryPromise({
    try: async (signal) => {
      const body = response.body
      if (body === null) return undefined
      const reader = body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      while (true) {
        if (signal.aborted) {
          await reader.cancel()
          return undefined
        }
        const { done, value } = await reader.read()
        if (done || value === undefined) break
        buffer += decoder.decode(value, { stream: true })
        const { frames, rest } = parseSseFrames(buffer)
        buffer = rest
        const matched = matchFrameById(frames, id)
        if (matched !== undefined) {
          await reader.cancel()
          return matched
        }
      }
      const tail = flushSseFrame(buffer)
      return tail === undefined ? undefined : matchFrameById([tail], id)
    },
    catch: (error) =>
      new McpError({ server: server.name, message: `failed to read SSE response: ${describe(error)}` }),
  })

/** Read the reply body as SSE or plain JSON depending on the response content-type. */
const readReply = (
  server: McpServer,
  response: Response,
  id: number,
): Effect.Effect<unknown, McpError> =>
  (response.headers.get("content-type") ?? "").includes("text/event-stream")
    ? readSseReply(server, response, id)
    : readJsonReply(server, response)

/** Turn a JSON-RPC envelope into its `.result`, mapping a JSON-RPC `.error` (or a malformed reply) to an `McpError`. */
const resultOf = (server: McpServer, envelope: unknown): Effect.Effect<unknown, McpError> => {
  if (!Predicate.isObject(envelope)) {
    return Effect.fail(
      new McpError({ server: server.name, message: "no matching JSON-RPC response received" }),
    )
  }
  const error = envelope["error"]
  if (error !== undefined && error !== null) {
    return Effect.fail(new McpError({ server: server.name, message: jsonRpcErrorMessage(error) }))
  }
  if ("result" in envelope) {
    return Effect.succeed(envelope["result"])
  }
  return Effect.fail(
    new McpError({
      server: server.name,
      message: "JSON-RPC response contained neither result nor error",
    }),
  )
}

/** One request/response round-trip; returns the extracted `.result` alongside the raw response (for header capture). */
const exchange = (
  server: McpServer,
  headers: Record<string, string>,
  id: number,
  method: string,
  params: unknown,
): Effect.Effect<{ readonly result: unknown; readonly response: Response }, McpError> =>
  sendFetch(server, headers, { jsonrpc: "2.0", id, method, params }).pipe(
    Effect.flatMap((response) =>
      ensureOk(server, response).pipe(
        Effect.flatMap(() => readReply(server, response, id)),
        Effect.flatMap((envelope) => resultOf(server, envelope)),
        Effect.map((result) => ({ result, response })),
      ),
    ),
    Effect.timeout("10 seconds"),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(
        new McpError({ server: server.name, message: `${method} request timed out after 10 seconds` }),
      ),
    ),
  )

/** `exchange` keeping only the extracted `.result`. */
const rpcResult = (
  server: McpServer,
  headers: Record<string, string>,
  id: number,
  method: string,
  params: unknown,
): Effect.Effect<unknown, McpError> =>
  exchange(server, headers, id, method, params).pipe(Effect.map((exchanged) => exchanged.result))

/** Fire a JSON-RPC notification (no `id`, no reply); the 202/empty body is discarded. */
const notify = (
  server: McpServer,
  headers: Record<string, string>,
  method: string,
): Effect.Effect<void, McpError> =>
  sendFetch(server, headers, { jsonrpc: "2.0", method }).pipe(
    Effect.flatMap((response) => ensureOk(server, response)),
    Effect.flatMap((response) =>
      Effect.ignore(Effect.tryPromise(() => response.body?.cancel() ?? Promise.resolve())),
    ),
    Effect.timeout("10 seconds"),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(
        new McpError({
          server: server.name,
          message: `${method} notification timed out after 10 seconds`,
        }),
      ),
    ),
  )

/** Reject a bad scheme or an SSRF-blocked host up front, before any network call. */
const ensureAllowed = (server: McpServer): Effect.Effect<void, McpError> =>
  Effect.try({
    try: () => new URL(server.url),
    catch: () => new McpError({ server: server.name, message: `invalid server URL: ${server.url}` }),
  }).pipe(
    Effect.flatMap((url) => {
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return Effect.fail(
          new McpError({
            server: server.name,
            message: `unsupported URL scheme: ${url.protocol} (only http/https)`,
          }),
        )
      }
      if (isBlockedHost(url.hostname)) {
        return Effect.fail(
          new McpError({
            server: server.name,
            message: `blocked host: ${url.hostname} (private/internal address)`,
          }),
        )
      }
      return Effect.void
    }),
  )

/** Map a decoded MCP tool definition to the client's `McpToolDef` shape. */
const toToolDef = (tool: McpSchema.Tool): McpToolDef => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
})

/** Flatten a strictly-decoded tool result: text blocks joined by newlines, other blocks replaced by a placeholder. */
const flattenStrict = (result: McpSchema.CallToolResult): McpCallResult => ({
  text: result.content
    .map((block) => (block.type === "text" ? block.text : NON_TEXT_PLACEHOLDER))
    .join("\n"),
  isError: result.isError === true,
})

/** Lenient flatten over raw JSON, used when strict decode fails (e.g. a base64 binary block trips `Schema.Uint8Array`). */
const flattenLenient = (result: unknown): McpCallResult => {
  const content = readField(result, "content")
  const blocks = Array.isArray(content) ? content : []
  const text = blocks
    .map((block) => {
      const type = readField(block, "type")
      const value = readField(block, "text")
      return type === "text" && typeof value === "string" ? value : NON_TEXT_PLACEHOLDER
    })
    .join("\n")
  return { text, isError: readField(result, "isError") === true }
}

/** Strict decode first; on a decode FAILURE degrade to the lenient path so a binary block still returns text. Narrowed to the failure channel so defects/interrupts are not masked. */
const flattenCallResult = (result: unknown): Effect.Effect<McpCallResult> =>
  decodeCallToolResult(result).pipe(
    Effect.map(flattenStrict),
    Effect.catch(() =>
      Effect.logDebug("mcp callTool result failed strict decode; using lenient text extraction").pipe(
        Effect.map(() => flattenLenient(result)),
      ),
    ),
  )

/** Connect to an MCP server: SSRF-check, run the handshake, and return a client bound to the negotiated session. */
export const connect = (server: McpServer): Effect.Effect<McpClient, McpError> =>
  Effect.gen(function* () {
    yield* ensureAllowed(server)

    let counter = 0
    const nextId = (): number => {
      counter += 1
      return counter
    }

    const init = yield* exchange(server, {}, nextId(), "initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    })
    const sessionId = init.response.headers.get("Mcp-Session-Id")
    const initialized = yield* decodeInitializeResult(init.result).pipe(
      Effect.mapError(
        (error) =>
          new McpError({ server: server.name, message: `invalid initialize result: ${describe(error)}` }),
      ),
    )

    const sessionHeaders: Record<string, string> = {
      "MCP-Protocol-Version": initialized.protocolVersion,
      ...(sessionId !== null ? { "Mcp-Session-Id": sessionId } : {}),
    }

    yield* notify(server, sessionHeaders, "notifications/initialized")

    const listTools: Effect.Effect<ReadonlyArray<McpToolDef>, McpError> = Effect.suspend(() =>
      rpcResult(server, sessionHeaders, nextId(), "tools/list", {}).pipe(
        Effect.flatMap((result) =>
          decodeListToolsResult(result).pipe(
            Effect.mapError(
              (error) =>
                new McpError({
                  server: server.name,
                  message: `invalid tools/list result: ${describe(error)}`,
                }),
            ),
          ),
        ),
        Effect.map((decoded) => decoded.tools.map(toToolDef)),
      ),
    )

    const callTool = (name: string, args: unknown): Effect.Effect<McpCallResult, McpError> =>
      Effect.suspend(() =>
        rpcResult(server, sessionHeaders, nextId(), "tools/call", { name, arguments: args }).pipe(
          Effect.flatMap((result) => flattenCallResult(result)),
        ),
      )

    return { listTools, callTool }
  })
