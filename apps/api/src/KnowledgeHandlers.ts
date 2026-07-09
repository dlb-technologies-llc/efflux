import { AgentApi, KnowledgeItem, KnowledgeItemResponse, KnowledgeListResponse } from "@effect-flue/shared"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { listKnowledge, uploadKnowledge } from "./Knowledge.ts"

/** Knowledge handlers for the `knowledge` group: list item status + upsert a document. `KnowledgeSearch` is provided at the Worker root. */
export const KnowledgeHandlers = HttpApiBuilder.group(AgentApi, "knowledge", (handlers) =>
  handlers
    .handle("listKnowledge", () =>
      Effect.gen(function* () {
        const items = yield* listKnowledge()
        return new KnowledgeListResponse({ items: items.map((i) => new KnowledgeItem(i)) })
      }),
    )
    .handle("putKnowledge", ({ params, payload }) =>
      Effect.gen(function* () {
        const item = yield* uploadKnowledge(params.name, payload.content)
        return new KnowledgeItemResponse({ item: new KnowledgeItem(item) })
      }),
    ),
)
