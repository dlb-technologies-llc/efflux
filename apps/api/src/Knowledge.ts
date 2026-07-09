import { AgentError } from "@effect-flue/shared"
import { Context, Effect } from "effect"

/** Runtime handle to the AI Search instance, provided per-isolate from `env.KNOWLEDGE_SEARCH`. */
export class KnowledgeSearch extends Context.Service<KnowledgeSearch, AiSearchInstance>()(
  "api/KnowledgeSearch",
) {}

/** Upsert a document into the instance's built-in storage; indexing is asynchronous. */
export const uploadKnowledge = Effect.fn("uploadKnowledge")(function* (
  name: string,
  content: string,
): Effect.fn.Return<{ name: string; id: string; status: string }, AgentError, KnowledgeSearch> {
  const instance = yield* KnowledgeSearch
  const info = yield* Effect.tryPromise({
    try: () => instance.items.upload(name, content),
    catch: (e) =>
      new AgentError({
        message: `AI Search upload failed for ${name}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      }),
  })
  return { name: info.key, id: info.id, status: info.status }
})

/** List every item with its indexing status, for polling until `completed`. */
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
  return res.result.map((i) => ({ name: i.key, id: i.id, status: i.status }))
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
  })
  if (res.chunks.length === 0) return "No relevant knowledge found."
  return res.chunks
    .map((c) => `[${c.item.key} · score ${c.score.toFixed(3)}]\n${c.text}`)
    .join("\n\n")
})
