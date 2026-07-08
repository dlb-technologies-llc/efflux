import { Schema } from "effect"
import { Prompt } from "effect/unstable/ai"
import { SafeName } from "./Schemas.ts"

/**
 * Journal event payloads — the append-only event vocabulary persisted in the
 * Agent DO's SQLite journal. History is a fold over these events.
 *
 * Two layers of prompt-reconstruction data coexist:
 *
 * - GRANULAR: `tool-call` / `tool-result` events embed the encoded Prompt
 *   part schemas (`Prompt.ToolCallPart` / `Prompt.ToolResultPart`) — NOT
 *   display-shaped StreamParts — giving per-call granularity for timelines
 *   and approvals.
 * - AUTHORITATIVE: one `hop-messages` event per tool hop stores exactly the
 *   `Prompt.Message`s that `Prompt.fromResponseParts` produced for that hop
 *   (assistant message with reasoning/text/tool-call parts in original order
 *   plus the tool message), so a parked turn's prompt is rebuilt without
 *   lossy regrouping.
 *
 * Every event except `user-message` carries `turn` — the seq of its own
 * turn's `user-message` event. Folds and reconstruction group by
 * `(turn, hop)`, never by seq adjacency: concurrent prompts to one session
 * interleave appends.
 */
export class JournalUserMessage extends Schema.TaggedClass<JournalUserMessage>()(
  "user-message",
  {
    content: Schema.String,
    // Snapshot of the overlay selection so a parked turn's system messages
    // can be re-loaded by name when rebuilding the prompt.
    skill: Schema.optionalKey(SafeName),
    role: Schema.optionalKey(SafeName),
    model: Schema.optionalKey(Schema.String),
  },
) {}

export class JournalAssistantText extends Schema.TaggedClass<JournalAssistantText>()(
  "assistant-text",
  {
    turn: Schema.Number,
    hop: Schema.Number,
    text: Schema.String,
  },
) {}

export class JournalToolCall extends Schema.TaggedClass<JournalToolCall>()(
  "tool-call",
  {
    turn: Schema.Number,
    hop: Schema.Number,
    part: Prompt.ToolCallPart,
  },
) {}

export class JournalToolResult extends Schema.TaggedClass<JournalToolResult>()(
  "tool-result",
  {
    turn: Schema.Number,
    hop: Schema.Number,
    part: Prompt.ToolResultPart,
  },
) {}

export class JournalHopMessages extends Schema.TaggedClass<JournalHopMessages>()(
  "hop-messages",
  {
    turn: Schema.Number,
    hop: Schema.Number,
    messages: Schema.Array(Prompt.Message),
  },
) {}

export class JournalUsage extends Schema.TaggedClass<JournalUsage>()("usage", {
  turn: Schema.Number,
  hop: Schema.Number,
  model: Schema.String,
  inputTokens: Schema.optionalKey(Schema.Number),
  outputTokens: Schema.optionalKey(Schema.Number),
  totalTokens: Schema.optionalKey(Schema.Number),
  // USD, from OpenRouter's raw usage accounting when present (streaming
  // always requests it; non-streaming responses may omit it).
  cost: Schema.optionalKey(Schema.Number),
}) {}

export class JournalDone extends Schema.TaggedClass<JournalDone>()("done", {
  turn: Schema.Number,
  finishReason: Schema.String,
  toolCallCount: Schema.Number,
}) {}

export class JournalErrorEvent extends Schema.TaggedClass<JournalErrorEvent>()(
  "error",
  {
    turn: Schema.Number,
    message: Schema.String,
  },
) {}

export const JournalEventPayload = Schema.Union([
  JournalUserMessage,
  JournalAssistantText,
  JournalToolCall,
  JournalToolResult,
  JournalHopMessages,
  JournalUsage,
  JournalDone,
  JournalErrorEvent,
])

export type JournalEventPayload = typeof JournalEventPayload.Type

/**
 * Envelope for one journal row: `seq` is the SQLite AUTOINCREMENT primary
 * key (monotonic, never reused after deletes — Last-Event-ID safe),
 * `createdAt` is epoch milliseconds.
 */
export class JournalEvent extends Schema.Class<JournalEvent>("JournalEvent")({
  seq: Schema.Number,
  createdAt: Schema.Number,
  event: JournalEventPayload,
}) {}

export class JournalResponse extends Schema.Class<JournalResponse>("JournalResponse")({
  events: Schema.Array(JournalEvent),
  // Cursor for the next page: pass as `?after=` — null when this page is
  // the last.
  nextAfter: Schema.NullOr(Schema.Number),
}) {}

export class SessionInfo extends Schema.Class<SessionInfo>("SessionInfo")({
  name: Schema.String,
  id: Schema.String,
  createdAt: Schema.Number,
  lastActiveAt: Schema.Number,
}) {}

export class SessionsResponse extends Schema.Class<SessionsResponse>("SessionsResponse")({
  sessions: Schema.Array(SessionInfo),
}) {}
