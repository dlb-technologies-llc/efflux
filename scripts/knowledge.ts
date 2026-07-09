#!/usr/bin/env bun
/** Live smoke for the AI Search knowledge demo: uploads two docs the base model can't know, polls until indexed, asks a grounded question, and checks the journal for a search_knowledge tool-call. */

import { AgentApi, makePromptRequest, PutKnowledgeRequest } from "../packages/shared/src/index.ts"
import { Console, Effect } from "effect"
import { HttpApiClient } from "effect/unstable/httpapi"
import { ApiClient, bootstrap, fetchAllEvents, runMain } from "./lib.ts"

const USAGE = [
  "Usage: bun run scripts/knowledge.ts <name> <id> [--url URL] [--model M]",
  "  Uploads two demo docs, polls until indexed, then asks a question answerable only from them.",
].join("\n")

/** Model pinned for the grounded prompt — gpt-4o-mini is reliable at tool use (the free default is weak; gpt-5.2 400s on the whole toolkit). */
const DEFAULT_MODEL = "openai/gpt-4o-mini"

/** Max poll attempts at 3s each (~2 min) before giving up on `completed` and prompting anyway — AI Search indexes asynchronously. */
const MAX_POLL_ATTEMPTS = 40

/** A distinctive fact that lives ONLY in the second demo doc — grep the final answer for it to prove grounding. */
const GROUNDED_TOKEN = "HYP-88231-DELTA"

/** Two demo docs whose facts the base model cannot know; the invented product code chains through both, so a correct answer must have read each. */
const DEMO_DOCS = [
  {
    name: "flue-demo-product-glossary",
    content:
      "INTERNAL PRODUCT GLOSSARY. Product code QX-9981-ZULU is the confidential codename for the Innovation Lab's experimental fusion module, internally called the 'Marmalade Falcon'. The Marmalade Falcon (QX-9981-ZULU) ships with exactly one classified subcomponent, part number BLZ-4471.",
  },
  {
    name: "flue-demo-component-registry",
    content:
      "CLASSIFIED COMPONENT REGISTRY. Subcomponent part number BLZ-4471 is officially named the 'Hyperion Manifold'. Its unique factory serial prefix is HYP-88231-DELTA. No other component in the catalog carries this serial prefix.",
  },
]

/** The question — answerable only by chaining the product code through both docs to its subcomponent's serial prefix. */
const QUESTION =
  "Our records reference product code QX-9981-ZULU. What is its internal codename, and what is the official name and factory serial prefix of its single classified subcomponent? Answer using only the knowledge base."

/** AI Search item statuses that will never reach `completed` — polling must stop on these rather than burn the whole timeout. */
const TERMINAL_FAILURE: ReadonlySet<string> = new Set(["error", "skipped"])

/** Poll outcome: all docs indexed, one hit a terminal failure, or attempts ran out. */
type PollOutcome = "completed" | "failed" | "timeout"

/** Poll the knowledge list until every named doc reports `completed` (→ "completed"), any lands in a terminal `error`/`skipped` (→ "failed", logging which), or attempts run out (→ "timeout"). */
const pollUntilIndexed = (
  api: HttpApiClient.ForApi<typeof AgentApi>,
  names: ReadonlySet<string>,
): Effect.Effect<PollOutcome, unknown> => {
  const go = (attempt: number): Effect.Effect<PollOutcome, unknown> =>
    api.knowledge.listKnowledge().pipe(
      Effect.flatMap((response) => {
        const relevant = response.items.filter((item) => names.has(item.name))
        const summary = relevant.map((item) => `${item.name}=${item.status}`).join(", ")
        const failed = relevant.filter((item) => TERMINAL_FAILURE.has(item.status))
        const done = Array.from(names).every(
          (docName) => relevant.some((item) => item.name === docName && item.status === "completed"),
        )
        return Console.log(
          `  [poll ${attempt}/${MAX_POLL_ATTEMPTS}] ${summary === "" ? "(no matching items yet)" : summary}`,
        ).pipe(
          Effect.flatMap(() => {
            if (failed.length > 0) {
              return Console.log(
                `  indexing failed for: ${failed.map((item) => `${item.name} (${item.status})`).join(", ")}`,
              ).pipe(Effect.flatMap(() => Effect.succeed<PollOutcome>("failed")))
            }
            if (done) return Effect.succeed<PollOutcome>("completed")
            if (attempt >= MAX_POLL_ATTEMPTS) return Effect.succeed<PollOutcome>("timeout")
            return Effect.sleep("3 seconds").pipe(Effect.flatMap(() => go(attempt + 1)))
          }),
        )
      }),
    )
  return go(1)
}

const { parsed, runtime } = bootstrap(process.argv.slice(2), new Set<string>(), USAGE)

const main = Effect.gen(function*() {
  const api = yield* ApiClient
  const name = parsed.positional[0]
  const id = parsed.positional[1]
  if (name === undefined || id === undefined) return yield* Effect.fail(new Error(USAGE))
  const model = parsed.flags["model"] ?? DEFAULT_MODEL

  yield* Console.log(`Uploading ${DEMO_DOCS.length} demo docs…`)
  const uploadedNames = yield* Effect.forEach(DEMO_DOCS, (doc) =>
    api.knowledge.putKnowledge({
      params: { name: doc.name },
      payload: new PutKnowledgeRequest({ content: doc.content }),
    }).pipe(
      Effect.tap((response) =>
        Console.log(`  put ${response.item.name} → ${response.item.status} (id ${response.item.id})`)
      ),
      Effect.map((response) => response.item.name),
    ))

  yield* Console.log("Polling until both docs report completed (indexing is async — may take minutes)…")
  const names = new Set(uploadedNames)
  const outcome = yield* pollUntilIndexed(api, names)
  if (outcome === "failed") {
    return yield* Effect.fail(
      new Error("Indexing failed for one or more docs (see statuses above) — aborting the grounded prompt."),
    )
  }
  if (outcome === "timeout") {
    yield* Console.log(
      "Timed out waiting for indexing — AI Search indexes asynchronously (minutes). Prompting anyway to show partial state.",
    )
  }

  yield* Console.log(`\nPrompting ${name}/${id} with model ${model}…\n${QUESTION}\n`)
  const response = yield* api.agents.prompt({
    params: { name, id },
    payload: makePromptRequest(QUESTION, { model }),
  })
  yield* Console.log(`\n--- response ---\n${response.text}\n----------------`)

  const events = yield* fetchAllEvents(api, name, id)
  const searchCalled = events.some(
    (entry) => entry.event._tag === "tool-call" && entry.event.part.name === "search_knowledge",
  )
  const tokenPresent = response.text.includes(GROUNDED_TOKEN)

  yield* Console.log(`\nsearch_knowledge tool-call in journal: ${searchCalled ? "YES" : "no"}`)
  yield* Console.log(`grounded token ${GROUNDED_TOKEN} in answer:  ${tokenPresent ? "YES" : "no"}`)
  yield* Console.log(
    searchCalled && tokenPresent
      ? "PASS — the model searched the knowledge base and answered from the indexed docs."
      : "PARTIAL — see above; indexing may still be running or the model skipped the search tool.",
  )
})

await runMain(main, runtime)
