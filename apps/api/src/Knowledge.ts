import { AgentError } from "@effect-flue/shared"
import { Context, Effect } from "effect"

/** Runtime handle to the AI Search instance, provided per-isolate from `env.KNOWLEDGE_SEARCH`. */
export class KnowledgeSearch extends Context.Service<KnowledgeSearch, AiSearchInstance>()(
  "api/KnowledgeSearch",
) {}

/** AI Search builtin storage infers document type from the item key's extension and rejects extensionless keys as `unsupported_file_type`; v1 uploads UTF-8 text, so keys carry `.md`. The `:name` path param is a dot-less SafeId, so the suffix is a storage detail added here and stripped back off {@link toName}. */
const KEY_SUFFIX = ".md"

/** `name` → the AI Search item key (`<name>.md`). */
const toKey = (name: string): string => `${name}${KEY_SUFFIX}`

/** AI Search item key → the caller-facing `name` (drops the `.md` this module added). */
const toName = (key: string): string =>
  key.endsWith(KEY_SUFFIX) ? key.slice(0, -KEY_SUFFIX.length) : key

/** Upsert a document into the instance's built-in storage; indexing is asynchronous. */
export const uploadKnowledge = Effect.fn("uploadKnowledge")(function* (
  name: string,
  content: string,
): Effect.fn.Return<{ name: string; id: string; status: string }, AgentError, KnowledgeSearch> {
  const instance = yield* KnowledgeSearch
  const info = yield* Effect.tryPromise({
    try: () => instance.items.upload(toKey(name), content),
    catch: (e) =>
      new AgentError({
        message: `AI Search upload failed for ${name}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      }),
  })
  return { name: toName(info.key), id: info.id, status: info.status }
})

/** List items with their indexing status (first page at AI Search's default page size — not paginated in v1), for polling until `completed`. */
export const listKnowledge = Effect.fn("listKnowledge")(function* (): Effect.fn.Return<
  ReadonlyArray<{ name: string; id: string; status: string }>,
  AgentError,
  KnowledgeSearch
> {
  const instance = yield* KnowledgeSearch
  const res = yield* Effect.tryPromise({
    try: () => instance.items.list(),
    catch: (e) =>
      new AgentError({
        message: `AI Search list failed: ${e instanceof Error ? e.message : String(e)}`,
      }),
  })
  return res.result.map((i) => ({ name: toName(i.key), id: i.id, status: i.status }))
})

/** Retrieve the top matching passages, formatted for the model to ground on. */
export const searchKnowledge = Effect.fn("searchKnowledge")(function* (
  query: string,
  maxNumResults: number,
): Effect.fn.Return<string, AgentError, KnowledgeSearch> {
  const instance = yield* KnowledgeSearch
  const res = yield* Effect.tryPromise({
    try: () =>
      instance.search({
        query,
        ai_search_options: { retrieval: { max_num_results: maxNumResults } },
      }),
    catch: (e) =>
      new AgentError({
        message: `AI Search query failed: ${e instanceof Error ? e.message : String(e)}`,
      }),
  }).pipe(
    Effect.timeout("15 seconds"),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(new AgentError({ message: "AI Search query timed out after 15 seconds" })),
    ),
  )
  if (res.chunks.length === 0) return "No relevant knowledge found."
  return res.chunks
    .map((c) => `[${toName(c.item.key)} · score ${c.score.toFixed(3)}]\n${c.text}`)
    .join("\n\n")
})
