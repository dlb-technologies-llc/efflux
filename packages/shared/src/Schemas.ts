import { Schema as Schema } from "effect"

export class Message extends Schema.Class<Message>("Message")({
  role: Schema.Literals(["user", "assistant"]),
  content: Schema.String,
}) {}

export class PromptRequest extends Schema.Class<PromptRequest>("PromptRequest")({
  message: Schema.String,
  model: Schema.optionalKey(Schema.String),
  skill: Schema.optionalKey(Schema.String),
}) {}

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

export const TaskRole = Schema.Literals(["support"])
export type TaskRole = typeof TaskRole.Type

export class SubagentTaskRequest extends Schema.Class<SubagentTaskRequest>("SubagentTaskRequest")({
  prompt: Schema.String.check(Schema.isMaxLength(8192)),
  role: Schema.optionalKey(TaskRole),
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
