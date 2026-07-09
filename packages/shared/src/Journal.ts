import { Schema } from "effect"
import { Prompt, Response as AiResponse } from "effect/unstable/ai"
import { NonNegativeInt, SafeName } from "./Schemas.ts"

/** Turn-opening user message; snapshots the overlay (skill/role/model) so a parked turn's system messages reload by name. */
export class JournalUserMessage extends Schema.TaggedClass<JournalUserMessage>()(
  "user-message",
  {
    content: Schema.String,
    skill: Schema.optionalKey(SafeName),
    role: Schema.optionalKey(SafeName),
    model: Schema.optionalKey(Schema.String),
  },
) {}

/** Assistant text emitted during a hop. */
export class JournalAssistantText extends Schema.TaggedClass<JournalAssistantText>()(
  "assistant-text",
  {
    turn: NonNegativeInt,
    hop: NonNegativeInt,
    text: Schema.String,
  },
) {}

/** A tool call the model requested — granular layer, embeds the encoded `Prompt.ToolCallPart`. */
export class JournalToolCall extends Schema.TaggedClass<JournalToolCall>()(
  "tool-call",
  {
    turn: NonNegativeInt,
    hop: NonNegativeInt,
    part: Prompt.ToolCallPart,
  },
) {}

/** A tool call's result — granular layer, embeds the encoded `Prompt.ToolResultPart`. */
export class JournalToolResult extends Schema.TaggedClass<JournalToolResult>()(
  "tool-result",
  {
    turn: NonNegativeInt,
    hop: NonNegativeInt,
    part: Prompt.ToolResultPart,
  },
) {}

/** A tool call parked awaiting approval; `toolCallId` matches the `JournalToolCall` in the same (turn, hop). */
export class JournalApprovalRequested extends Schema.TaggedClass<JournalApprovalRequested>()(
  "approval-requested",
  {
    turn: NonNegativeInt,
    hop: NonNegativeInt,
    approvalId: Schema.String,
    toolCallId: Schema.String,
  },
) {}

/** Resolution of a parked approval (granted or denied). */
export class JournalApprovalResolved extends Schema.TaggedClass<JournalApprovalResolved>()(
  "approval-resolved",
  {
    turn: NonNegativeInt,
    approvalId: Schema.String,
    approved: Schema.Boolean,
    reason: Schema.optionalKey(Schema.String),
  },
) {}

/** Authoritative per-hop `Prompt.Message`s for lossless prompt rebuild of a parked turn. */
export class JournalHopMessages extends Schema.TaggedClass<JournalHopMessages>()(
  "hop-messages",
  {
    turn: NonNegativeInt,
    hop: NonNegativeInt,
    messages: Schema.Array(Prompt.Message),
  },
) {}

/** Per-hop usage accounting; `cost` is USD from OpenRouter's raw accounting when present. */
export class JournalUsage extends Schema.TaggedClass<JournalUsage>()("usage", {
  turn: NonNegativeInt,
  hop: NonNegativeInt,
  model: Schema.String,
  inputTokens: Schema.optionalKey(NonNegativeInt),
  outputTokens: Schema.optionalKey(NonNegativeInt),
  totalTokens: Schema.optionalKey(NonNegativeInt),
  cost: Schema.optionalKey(Schema.Number),
}) {}

/** Terminal event for a turn. */
export class JournalDone extends Schema.TaggedClass<JournalDone>()("done", {
  turn: NonNegativeInt,
  finishReason: AiResponse.FinishReason,
  toolCallCount: NonNegativeInt,
}) {}

/** A turn-level error. */
export class JournalErrorEvent extends Schema.TaggedClass<JournalErrorEvent>()(
  "error",
  {
    turn: NonNegativeInt,
    message: Schema.String,
  },
) {}

/**
 * The append-only event vocabulary persisted in the Agent DO's SQLite journal;
 * history is a fold over these. Two prompt-reconstruction layers coexist:
 * GRANULAR `tool-call`/`tool-result` events embed encoded `Prompt` part schemas
 * for per-call timelines and approvals; AUTHORITATIVE `hop-messages` stores the
 * exact per-hop `Prompt.Message`s for lossless rebuild. Every event but
 * `user-message` carries `turn`; folds group by `(turn, hop)`, never seq
 * adjacency (concurrent prompts to one session interleave appends).
 */
export const JournalEventPayload = Schema.Union([
  JournalUserMessage,
  JournalAssistantText,
  JournalToolCall,
  JournalToolResult,
  JournalApprovalRequested,
  JournalApprovalResolved,
  JournalHopMessages,
  JournalUsage,
  JournalDone,
  JournalErrorEvent,
])

export type JournalEventPayload = typeof JournalEventPayload.Type

/** Envelope for one journal row: `seq` is the SQLite AUTOINCREMENT key (monotonic, never reused — Last-Event-ID safe), `createdAt` is epoch ms. */
export class JournalEvent extends Schema.Class<JournalEvent>("JournalEvent")({
  seq: NonNegativeInt,
  createdAt: NonNegativeInt,
  event: JournalEventPayload,
}) {}

/** A page of journal events; `nextAfter` is the cursor for the next page (pass as `?after=`), null when this is the last page. */
export class JournalResponse extends Schema.Class<JournalResponse>("JournalResponse")({
  events: Schema.Array(JournalEvent),
  nextAfter: Schema.NullOr(Schema.Number),
}) {}

/** Registry entry for one session. */
export class SessionInfo extends Schema.Class<SessionInfo>("SessionInfo")({
  name: Schema.String,
  id: Schema.String,
  createdAt: NonNegativeInt,
  lastActiveAt: NonNegativeInt,
}) {}

/** All known sessions. */
export class SessionsResponse extends Schema.Class<SessionsResponse>("SessionsResponse")({
  sessions: Schema.Array(SessionInfo),
}) {}
