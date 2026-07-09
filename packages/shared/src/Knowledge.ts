import { Schema } from "effect"

/** Upsert body for `PUT /knowledge/:name` — the document's UTF-8 text. */
export class PutKnowledgeRequest extends Schema.Class<PutKnowledgeRequest>("PutKnowledgeRequest")({
  content: Schema.String,
}) {}

/** One knowledge item's indexing state. `status` is a free String (CF's status union is a generated type — a Schema.Literals re-listing would drift). */
export class KnowledgeItem extends Schema.Class<KnowledgeItem>("KnowledgeItem")({
  name: Schema.String,
  id: Schema.String,
  status: Schema.String,
}) {}

/** Response for `PUT /knowledge/:name` — the just-uploaded item (typically `queued`/`running`). */
export class KnowledgeItemResponse extends Schema.Class<KnowledgeItemResponse>("KnowledgeItemResponse")({
  item: KnowledgeItem,
}) {}

/** Response for `GET /knowledge` — every item with status, for polling until `completed`. */
export class KnowledgeListResponse extends Schema.Class<KnowledgeListResponse>("KnowledgeListResponse")({
  items: Schema.Array(KnowledgeItem),
}) {}
