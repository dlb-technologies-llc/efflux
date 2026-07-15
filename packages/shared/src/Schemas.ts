import { Schema } from "effect"

const SAFE_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/
/** Safe identifier for URL path segments and R2 object keys — bounds the keyspace so callers can't probe R2 via `skills/<key>.md` / `roles/<key>.md`. */
export const SafeName = Schema.String.pipe(
  Schema.refine((s): s is string => SAFE_NAME_PATTERN.test(s), {
    title: "SafeName",
    description: "alphanumeric, hyphen, underscore; 1-64 chars",
  }),
)

const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/
/** Safe identifier for `:name` / `:id` path segments backed by DO ids — constrains characters to prevent path-traversal-style attacks. */
export const SafeId = Schema.String.pipe(
  Schema.refine((s): s is string => SAFE_ID_PATTERN.test(s), {
    title: "SafeId",
    description: "alphanumeric, hyphen, underscore; 1-128 chars",
  }),
)

/** Non-negative integer — journal seqs, timestamps, counts, event ids (rejects NaN, negatives, floats). The single shared source for the whole contract. */
export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** The coordinates a parked turn resumes from: the journal `eventId` to POST to `/approve/:eventId`, plus `approvalId`/`toolCallId` correlating the parked tool call. */
export const ApprovalHandle = Schema.Struct({
  eventId: NonNegativeInt,
  approvalId: Schema.String,
  toolCallId: Schema.String,
})

/** A single chat message (user or assistant). `skill` is the overlay a user turn was invoked with (via a `/skill` slash command or the persistent picker); present only on user messages that carried one, so the transcript can show which skill shaped the turn. */
export class Message extends Schema.Class<Message>("Message")({
  role: Schema.Literals(["user", "assistant"]),
  content: Schema.String,
  skill: Schema.optionalKey(SafeName),
}) {}

/** RPC-safe plain message shape — `Pick<Message, …>` yields `{ role: "user"|"assistant"; content: string; skill?: string }`, which survives the DO RPC type fence where `typeof Message.Encoded` would widen `role` back to `string`. */
export type PlainMessage = Pick<Message, "role" | "content" | "skill">

/** Max length for a model id (forwarded to OpenRouter) — the single source shared by every model-id cap across the contract. */
export const MODEL_ID_MAX_LENGTH = 128

/** Primary user-facing prompt payload — generous message cap, tight model cap (forwarded to OpenRouter). */
export class PromptRequest extends Schema.Class<PromptRequest>("PromptRequest")({
  message: Schema.String.check(Schema.isMaxLength(100_000)),
  model: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(MODEL_ID_MAX_LENGTH))),
  skill: Schema.optionalKey(SafeName),
  role: Schema.optionalKey(SafeName),
}) {}

/**
 * The overlay overrides accepted alongside a prompt — derived from
 * `PromptRequest`'s encoded shape so the `SafeName` refinement on skill/role
 * can never drift into a bare `string`.
 */
export type PromptOverrides = Pick<
  typeof PromptRequest.Encoded,
  "model" | "skill" | "role"
>

/** Build a real `PromptRequest` instance (required across the DO RPC fence and by the HttpApiClient encoder — see ISSUES.md) from a message plus optional overrides. */
export const makePromptRequest = (
  message: string,
  overrides: PromptOverrides = {},
): PromptRequest =>
  new PromptRequest({
    message,
    ...(overrides.model !== undefined ? { model: overrides.model } : {}),
    ...(overrides.skill !== undefined ? { skill: overrides.skill } : {}),
    ...(overrides.role !== undefined ? { role: overrides.role } : {}),
  })

/** Prompt turn result; `approval` is present only when the turn parked awaiting approval (finishReason "tool-calls"), carrying the eventId to POST to /approve/:eventId. */
export class PromptResponse extends Schema.Class<PromptResponse>("PromptResponse")({
  text: Schema.String,
  finishReason: Schema.String,
  toolCallCount: NonNegativeInt,
  model: Schema.String,
  messageCount: NonNegativeInt,
  approval: Schema.optionalKey(ApprovalHandle),
}) {}

/** A session's chat history. */
export class HistoryResponse extends Schema.Class<HistoryResponse>("HistoryResponse")({
  history: Schema.Array(Message),
}) {}

/** Subagent task request dispatched to /tasks. */
export class SubagentTaskRequest extends Schema.Class<SubagentTaskRequest>("SubagentTaskRequest")({
  prompt: Schema.String.check(Schema.isMaxLength(8192)),
  skill: Schema.optionalKey(SafeName),
  role: Schema.optionalKey(SafeName),
  model: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(MODEL_ID_MAX_LENGTH))),
}) {}

/** Subagent task result. */
export class SubagentTaskResponse extends Schema.Class<SubagentTaskResponse>("SubagentTaskResponse")({
  text: Schema.String,
  model: Schema.String,
  finishReason: Schema.String,
}) {}

/** Approve/deny decision for a parked tool call; approved defaults true when omitted, reason is surfaced to the model on denial. */
export class ApprovalDecision extends Schema.Class<ApprovalDecision>("ApprovalDecision")({
  approved: Schema.optionalKey(Schema.Boolean),
  reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
}) {}

/** SSE frame: incremental assistant text. */
export class StreamPartTextDelta extends Schema.TaggedClass<StreamPartTextDelta>()(
  "text-delta",
  {
    delta: Schema.String,
  },
) {}

/** SSE frame: a tool call the model requested. */
export class StreamPartToolCall extends Schema.TaggedClass<StreamPartToolCall>()(
  "tool-call",
  {
    id: Schema.String,
    name: Schema.String,
    params: Schema.Unknown,
  },
) {}

/** SSE frame: the result of a tool call. */
export class StreamPartToolResult extends Schema.TaggedClass<StreamPartToolResult>()(
  "tool-result",
  {
    id: Schema.String,
    result: Schema.Unknown,
    isFailure: Schema.Boolean,
  },
) {}

/** SSE frame: terminal frame with finish reason and tool-call count. */
export class StreamPartDone extends Schema.TaggedClass<StreamPartDone>()("done", {
  finishReason: Schema.String,
  toolCallCount: NonNegativeInt,
}) {}

/** SSE frame: a stream-level error. */
export class StreamPartError extends Schema.TaggedClass<StreamPartError>()(
  "error",
  {
    message: Schema.String,
  },
) {}

/** SSE frame: a parked tool call awaiting approval; `eventId` is the journal seq to POST to /approve/:eventId, `approvalId`/`toolCallId` correlate with the preceding tool-call frame. */
export class StreamPartApprovalRequest extends Schema.TaggedClass<StreamPartApprovalRequest>()(
  "approval-request",
  ApprovalHandle.fields,
) {}

/** Discriminated union of all SSE stream frames. */
export const StreamPart = Schema.Union([
  StreamPartTextDelta,
  StreamPartToolCall,
  StreamPartToolResult,
  StreamPartDone,
  StreamPartError,
  StreamPartApprovalRequest,
])

export type StreamPart = typeof StreamPart.Type
