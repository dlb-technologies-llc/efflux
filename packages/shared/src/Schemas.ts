import { Schema } from "effect"

// Shared safe-identifier pattern for URL path segments AND R2 object keys.
// The latter use applies to `skill` and `role` below, where unconstrained
// input would let any caller probe the R2 keyspace via `skills/<key>.md` /
// `roles/<key>.md` and would let an unbounded per-isolate cache grow one
// entry per unique input. Same constraint as AgentApi's `:name` / `:id`.
const SAFE_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/
export const SafeName = Schema.String.pipe(
  Schema.refine((s): s is string => SAFE_NAME_PATTERN.test(s), {
    title: "SafeName",
    description: "alphanumeric, hyphen, underscore; 1-64 chars",
  }),
)

export class Message extends Schema.Class<Message>("Message")({
  role: Schema.Literals(["user", "assistant"]),
  content: Schema.String,
}) {}

export class PromptRequest extends Schema.Class<PromptRequest>("PromptRequest")({
  // Primary user-facing payload. Bounded like SubagentTaskRequest below: a
  // generous message cap (long prompts are legitimate) and a tight model cap
  // (it forwards to OpenRouter).
  message: Schema.String.check(Schema.isMaxLength(100_000)),
  model: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
  skill: Schema.optionalKey(SafeName),
  role: Schema.optionalKey(SafeName),
}) {}

/**
 * The overlay overrides accepted alongside a prompt message — derived from
 * `PromptRequest`'s encoded shape so the `SafeName` refinement on skill/role
 * can never drift into a bare `string`.
 */
export type PromptOverrides = Pick<
  typeof PromptRequest.Encoded,
  "model" | "skill" | "role"
>

/**
 * Build a `PromptRequest` class instance (a real instance is required across
 * the DO RPC fence and by the HttpApiClient encoder — see ISSUES.md) from a
 * message plus optional overlay overrides. Centralizes the conditional-spread
 * construction that was previously copy-pasted across apps/web and apps/tui.
 */
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

export class PromptResponse extends Schema.Class<PromptResponse>("PromptResponse")({
  text: Schema.String,
  finishReason: Schema.String,
  toolCallCount: Schema.Number,
  model: Schema.String,
  messageCount: Schema.Number,
}) {}

export class HistoryResponse extends Schema.Class<HistoryResponse>("HistoryResponse")({
  history: Schema.Array(Message),
}) {}

export class SubagentTaskRequest extends Schema.Class<SubagentTaskRequest>("SubagentTaskRequest")({
  prompt: Schema.String.check(Schema.isMaxLength(8192)),
  skill: Schema.optionalKey(SafeName),
  role: Schema.optionalKey(SafeName),
  model: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
}) {}

export class SubagentTaskResponse extends Schema.Class<SubagentTaskResponse>("SubagentTaskResponse")({
  text: Schema.String,
  model: Schema.String,
  finishReason: Schema.String,
}) {}

export class StreamPartTextDelta extends Schema.TaggedClass<StreamPartTextDelta>()(
  "text-delta",
  {
    delta: Schema.String,
  },
) {}

export class StreamPartToolCall extends Schema.TaggedClass<StreamPartToolCall>()(
  "tool-call",
  {
    id: Schema.String,
    name: Schema.String,
    params: Schema.Unknown,
  },
) {}

export class StreamPartToolResult extends Schema.TaggedClass<StreamPartToolResult>()(
  "tool-result",
  {
    id: Schema.String,
    result: Schema.Unknown,
    isFailure: Schema.Boolean,
  },
) {}

export class StreamPartDone extends Schema.TaggedClass<StreamPartDone>()("done", {
  finishReason: Schema.String,
  toolCallCount: Schema.Number,
}) {}

export class StreamPartError extends Schema.TaggedClass<StreamPartError>()(
  "error",
  {
    message: Schema.String,
  },
) {}

export const StreamPart = Schema.Union([
  StreamPartTextDelta,
  StreamPartToolCall,
  StreamPartToolResult,
  StreamPartDone,
  StreamPartError,
])

export type StreamPart = typeof StreamPart.Type
