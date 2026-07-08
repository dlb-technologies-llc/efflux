import { Schema } from "effect"
import { Prompt, Response as AiResponse } from "effect/unstable/ai"
import { SafeName } from "./Schemas.ts"

// seq (AUTOINCREMENT key), createdAt (epoch ms), turn/hop, and token counts
// are all non-negative integers — a bare Schema.Number would accept NaN,
// negatives, and floats. Applied everywhere those appear below.
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

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
    turn: NonNegativeInt,
    hop: NonNegativeInt,
    text: Schema.String,
  },
) {}

export class JournalToolCall extends Schema.TaggedClass<JournalToolCall>()(
  "tool-call",
  {
    turn: NonNegativeInt,
    hop: NonNegativeInt,
    part: Prompt.ToolCallPart,
  },
) {}

export class JournalToolResult extends Schema.TaggedClass<JournalToolResult>()(
  "tool-result",
  {
    turn: NonNegativeInt,
    hop: NonNegativeInt,
    part: Prompt.ToolResultPart,
  },
) {}

export class JournalHopMessages extends Schema.TaggedClass<JournalHopMessages>()(
  "hop-messages",
  {
    turn: NonNegativeInt,
    hop: NonNegativeInt,
    messages: Schema.Array(Prompt.Message),
  },
) {}

export class JournalUsage extends Schema.TaggedClass<JournalUsage>()("usage", {
  turn: NonNegativeInt,
  hop: NonNegativeInt,
  model: Schema.String,
  inputTokens: Schema.optionalKey(NonNegativeInt),
  outputTokens: Schema.optionalKey(NonNegativeInt),
  totalTokens: Schema.optionalKey(NonNegativeInt),
  // USD, from OpenRouter's raw usage accounting when present (streaming
  // always requests it; non-streaming responses may omit it).
  cost: Schema.optionalKey(Schema.Number),
}) {}

export class JournalDone extends Schema.TaggedClass<JournalDone>()("done", {
  turn: NonNegativeInt,
  finishReason: AiResponse.FinishReason,
  toolCallCount: NonNegativeInt,
}) {}

export class JournalErrorEvent extends Schema.TaggedClass<JournalErrorEvent>()(
  "error",
  {
    turn: NonNegativeInt,
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
  seq: NonNegativeInt,
  createdAt: NonNegativeInt,
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
  createdAt: NonNegativeInt,
  lastActiveAt: NonNegativeInt,
}) {}

export class SessionsResponse extends Schema.Class<SessionsResponse>("SessionsResponse")({
  sessions: Schema.Array(SessionInfo),
}) {}
