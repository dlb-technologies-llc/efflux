import { Schema } from "effect"
import { SafeName } from "./Schemas.ts"

/** Listing row for `GET /memory` — name + one-line description only, so the index stays cheap to inject into the system prompt. */
export class MemorySummary extends Schema.Class<MemorySummary>("MemorySummary")({
  name: SafeName,
  description: Schema.String,
  updatedAt: Schema.Number,
}) {}

/** One full memory fact — the named content stored per agent name, with creation/update timestamps. */
export class MemoryEntry extends Schema.Class<MemoryEntry>("MemoryEntry")({
  name: SafeName,
  description: Schema.String,
  content: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
}) {}

/** Response for `GET /memory` — the agent name's memory index. */
export class MemoryListResponse extends Schema.Class<MemoryListResponse>("MemoryListResponse")({
  memories: Schema.Array(MemorySummary),
}) {}

/** Upsert body for `PUT /memory/:name` — a one-line description plus the fact's content, both size-capped. */
export class PutMemoryRequest extends Schema.Class<PutMemoryRequest>("PutMemoryRequest")({
  description: Schema.String.check(Schema.isMaxLength(256)),
  content: Schema.String.check(Schema.isMaxLength(16_384)),
}) {}

/** Raised when the named memory is absent for this agent name; surfaces as HTTP 404. */
export class MemoryNotFoundError extends Schema.TaggedErrorClass<MemoryNotFoundError>()(
  "MemoryNotFoundError",
  {
    name: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

/** Raised when a memory write violates a cap (entry count, description, or content size); surfaces as HTTP 400. */
export class MemoryLimitError extends Schema.TaggedErrorClass<MemoryLimitError>()(
  "MemoryLimitError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

/** RPC-safe memory summary — `Schema.Class` instances cannot cross a Cloudflare DO RPC boundary and `typeof MemorySummary.Encoded` does not survive the DO-stub type transform, so `Pick<>` is the mandated derivation. */
export type PlainMemorySummary = Pick<MemorySummary, "name" | "description" | "updatedAt">

/** RPC-safe memory entry — `Schema.Class` instances cannot cross a Cloudflare DO RPC boundary and `typeof MemoryEntry.Encoded` does not survive the DO-stub type transform, so `Pick<>` is the mandated derivation. */
export type PlainMemoryEntry = Pick<MemoryEntry, "name" | "description" | "content" | "createdAt" | "updatedAt">

/** RPC-safe write outcome — `entry` is non-null exactly when `saved` is true (the DO returns the written row so callers never read back); plain because `Schema.Class` instances cannot cross a Cloudflare DO RPC boundary. */
export type MemoryWriteResult = { readonly saved: boolean; readonly error: string | null; readonly entry: PlainMemoryEntry | null }

/** RPC-safe delete outcome — plain because `Schema.Class` instances cannot cross a Cloudflare DO RPC boundary. */
export type MemoryDeleteResult = { readonly deleted: boolean }

/** Cap on stored memories per agent name — a write beyond this raises `MemoryLimitError`. */
export const MEMORY_MAX_ENTRIES = 200

/** Cap on a memory's content size — mirrors `PutMemoryRequest.content`'s `isMaxLength(16_384)` check. */
export const MEMORY_MAX_CONTENT_BYTES = 16384

/** Cap on a memory's one-line description size — mirrors `PutMemoryRequest.description`'s `isMaxLength(256)` check. */
export const MEMORY_MAX_DESCRIPTION_BYTES = 256
