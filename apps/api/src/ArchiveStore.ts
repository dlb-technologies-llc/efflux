import { AgentError, ArchiveSummary, SessionArchive } from "@efflux/shared"
import { Context, Effect, Schema } from "effect"

/** Runtime handle to the sessions R2 bucket (holds workspace snapshots AND the `archives/` corpus), provided per-isolate from `env.SESSIONS`. */
export class SessionsBucket extends Context.Service<SessionsBucket, R2Bucket>()(
  "api/SessionsBucket",
) {}

/** Run one R2 op, wrapping any thrown failure as an AgentError tagged with the op + key. */
const r2 = <A>(
  op: string,
  key: string,
  run: () => Promise<A>,
): Effect.Effect<A, AgentError> =>
  Effect.tryPromise({
    try: run,
    catch: (e) =>
      new AgentError({
        message: `R2 ${op} failed for ${key}: ${e instanceof Error ? e.message : String(e)}`,
      }),
  })

const decodeArchive = Schema.decodeUnknownEffect(SessionArchive)

const ARCHIVE_PREFIX = "archives/"
const JOURNAL_SUFFIX = "/journal.json"

/** List the archived-session corpus index: `name`/`id`/`closedAt` parsed from each `journal.json` key, `sizeBytes` from R2 object metadata, newest close first. Pages the full `archives/` prefix (R2 caps a list page at 1000 keys and each session writes two objects, so a single page truncates the corpus at ~500 sessions); no per-object body read. Malformed keys are skipped rather than failing the whole list. */
export const listArchives = Effect.fn("listArchives")(function* (): Effect.fn.Return<
  ReadonlyArray<ArchiveSummary>,
  AgentError,
  SessionsBucket
> {
  const bucket = yield* SessionsBucket

  const summaries: Array<ArchiveSummary> = []
  let cursor: string | undefined = undefined
  while (true) {
    const options: R2ListOptions =
      cursor === undefined
        ? { prefix: ARCHIVE_PREFIX }
        : { prefix: ARCHIVE_PREFIX, cursor }
    const listed = yield* r2("list", ARCHIVE_PREFIX, () => bucket.list(options))
    for (const object of listed.objects) {
      if (!object.key.endsWith(JOURNAL_SUFFIX)) continue
      const parts = object.key
        .slice(ARCHIVE_PREFIX.length, -JOURNAL_SUFFIX.length)
        .split("/")
      if (parts.length !== 3) continue
      const [name, id, closedAtRaw] = parts
      if (name === undefined || id === undefined || closedAtRaw === undefined) continue
      const closedAt = Number(closedAtRaw)
      if (!(Number.isInteger(closedAt) && closedAt >= 0)) continue
      if (!(Number.isInteger(object.size) && object.size >= 0)) continue
      summaries.push(new ArchiveSummary({ name, id, closedAt, sizeBytes: object.size }))
    }
    if (!listed.truncated) break
    cursor = listed.cursor
  }

  summaries.sort((a, b) => b.closedAt - a.closedAt)
  return summaries
})

/** Read one archived session's full journal by its three key segments. 404s (as an AgentError) when absent; a malformed body or a decode failure also surfaces as an AgentError so the error channel stays `AgentError` only. Reads R2 in the Worker handler — no DO RPC fence — so returning the `SessionArchive` Schema.Class is fine. */
export const getArchive = Effect.fn("getArchive")(function* (
  name: string,
  id: string,
  closedAt: number,
): Effect.fn.Return<SessionArchive, AgentError, SessionsBucket> {
  const key = `${ARCHIVE_PREFIX}${name}/${id}/${closedAt}${JOURNAL_SUFFIX}`
  const bucket = yield* SessionsBucket
  const obj = yield* r2("get", key, () => bucket.get(key))

  if (obj === null) {
    return yield* Effect.fail(new AgentError({ message: `archive not found: ${key}` }))
  }

  const text = yield* r2("body read", key, () => obj.text())
  const parsed = yield* Effect.try({
    try: () => JSON.parse(text),
    catch: (e) =>
      new AgentError({
        message: `R2 body parse failed for ${key}: ${e instanceof Error ? e.message : String(e)}`,
      }),
  })

  return yield* decodeArchive(parsed).pipe(
    Effect.mapError(
      (e) => new AgentError({ message: `R2 decode failed for ${key}: ${e.message}` }),
    ),
  )
})
