/** Shared plumbing for the CLI scripts: typed AgentApi client, journal pagination, and argv parsing. */

import type { JournalEvent } from "../packages/shared/src/index.ts"
import { AgentApi } from "../packages/shared/src/index.ts"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { HttpApiClient } from "effect/unstable/httpapi"

export class ApiClient extends Context.Service<ApiClient, HttpApiClient.ForApi<typeof AgentApi>>()(
  "@effect-flue/scripts/ApiClient",
) {}

/** FetchHttpClient wrapped once to attach the API bearer token to every outgoing request. */
const AuthedHttpClient = Layer.effect(
  HttpClient.HttpClient,
  Effect.map(
    HttpClient.HttpClient,
    HttpClient.mapRequest(
      HttpClientRequest.setHeader("Authorization", `Bearer ${process.env["API_TOKEN"] ?? ""}`),
    ),
  ),
).pipe(Layer.provide(FetchHttpClient.layer))

/** A ManagedRuntime whose context has the typed AgentApi client. */
export const makeRuntime = (baseUrl: string) =>
  ManagedRuntime.make(
    Layer.effect(ApiClient, HttpApiClient.make(AgentApi, { baseUrl })).pipe(
      Layer.provide(AuthedHttpClient),
    ),
  )

/** Flag ?? BASE_URL env, trailing slash stripped; undefined when neither set. */
export const resolveBaseUrl = (flagUrl: string | undefined): string | undefined => {
  const raw = flagUrl ?? process.env["BASE_URL"]
  return raw === undefined || raw === "" ? undefined : raw.replace(/\/$/, "")
}

export interface ParsedArgs {
  readonly positional: ReadonlyArray<string>
  readonly flags: Readonly<Record<string, string>>
}

/** Parse `[positionals] [--flag value] [--boolFlag]` argv; returns `{ error }` (not exit) on a missing flag value. */
export const parseArgs = (
  argv: ReadonlyArray<string>,
  booleanFlags: ReadonlySet<string>,
): ParsedArgs | { readonly error: string } => {
  const positional: Array<string> = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined) continue
    if (arg.startsWith("--")) {
      const key = arg.slice(2)
      if (booleanFlags.has(key)) {
        flags[key] = "true"
        continue
      }
      const value = argv[i + 1]
      if (value === undefined || value.startsWith("--")) {
        return { error: `Missing value for --${key}` }
      }
      flags[key] = value
      i++
    } else {
      positional.push(arg)
    }
  }
  return { positional, flags }
}

/** Fetch a session's entire journal, following pagination; recurses in the Effect channel (no mutable cursor). */
export const fetchAllEvents = (
  api: HttpApiClient.ForApi<typeof AgentApi>,
  name: string,
  id: string,
): Effect.Effect<ReadonlyArray<JournalEvent>, unknown> => {
  const go = (
    after: number,
    acc: ReadonlyArray<JournalEvent>,
  ): Effect.Effect<ReadonlyArray<JournalEvent>, unknown> =>
    api.agents.journal({ params: { name, id }, query: { after } }).pipe(
      Effect.flatMap((page) => {
        const next = [...acc, ...page.events]
        return page.nextAfter === null ? Effect.succeed(next) : go(page.nextAfter, next)
      }),
    )
  return go(0, [])
}
