import { Schema } from "effect"

/** One OpenAI chat message. Only `role`+`content` are consumed; `content` may be null on assistant tool-call turns some clients replay. */
export class ChatMessage extends Schema.Class<ChatMessage>("ChatMessage")({
  role: Schema.Literals(["system", "user", "assistant", "tool"]),
  content: Schema.NullOr(Schema.String),
}) {}

/** OpenAI `POST /v1/chat/completions` request body. Unlisted fields (temperature, top_p, tools, …) are stripped on decode. `model` is the session address `agent:<name>:<id>`. */
export class ChatCompletionRequest extends Schema.Class<ChatCompletionRequest>("ChatCompletionRequest")({
  model: Schema.String.check(Schema.isMaxLength(256)),
  messages: Schema.Array(ChatMessage).check(Schema.isMinLength(1)),
  stream: Schema.optionalKey(Schema.Boolean),
}) {}

/** One choice in a non-stream completion. */
export class ChatCompletionChoice extends Schema.Class<ChatCompletionChoice>("ChatCompletionChoice")({
  index: Schema.Number,
  message: Schema.Struct({ role: Schema.Literal("assistant"), content: Schema.String }),
  finish_reason: Schema.String,
}) {}

/** Token accounting echoed to the client. */
export class ChatCompletionUsage extends Schema.Class<ChatCompletionUsage>("ChatCompletionUsage")({
  prompt_tokens: Schema.Number,
  completion_tokens: Schema.Number,
  total_tokens: Schema.Number,
}) {}

/** Non-stream `chat.completion` response body. */
export class ChatCompletionResponse extends Schema.Class<ChatCompletionResponse>("ChatCompletionResponse")({
  id: Schema.String,
  object: Schema.Literal("chat.completion"),
  created: Schema.Number,
  model: Schema.String,
  choices: Schema.Array(ChatCompletionChoice),
  usage: ChatCompletionUsage,
}) {}

/** One streamed `chat.completion.chunk` delta frame. */
export class ChatCompletionChunk extends Schema.Class<ChatCompletionChunk>("ChatCompletionChunk")({
  id: Schema.String,
  object: Schema.Literal("chat.completion.chunk"),
  created: Schema.Number,
  model: Schema.String,
  choices: Schema.Array(
    Schema.Struct({
      index: Schema.Number,
      delta: Schema.Struct({
        role: Schema.optionalKey(Schema.Literal("assistant")),
        content: Schema.optionalKey(Schema.String),
      }),
      finish_reason: Schema.NullOr(Schema.String),
    }),
  ),
}) {}

/** One entry in `GET /v1/models`. */
export class ModelObject extends Schema.Class<ModelObject>("ModelObject")({
  id: Schema.String,
  object: Schema.Literal("model"),
  created: Schema.Number,
  owned_by: Schema.String,
}) {}

/** `GET /v1/models` response body. */
export class ModelsResponse extends Schema.Class<ModelsResponse>("ModelsResponse")({
  object: Schema.Literal("list"),
  data: Schema.Array(ModelObject),
}) {}

const AGENT_MODEL_PATTERN = /^agent:([a-zA-Z0-9_-]{1,128}):([a-zA-Z0-9_-]{1,128})$/

/** Parse a `model` field into a session address, or `undefined` when it is not a well-formed `agent:<name>:<id>`. */
export const parseAgentModel = (model: string): { name: string; id: string } | undefined => {
  const match = AGENT_MODEL_PATTERN.exec(model)
  return match !== null && match[1] !== undefined && match[2] !== undefined
    ? { name: match[1], id: match[2] }
    : undefined
}

/** Build the `agent:<name>:<id>` model id from a session's name+id. */
export const formatAgentModel = (name: string, id: string): string => `agent:${name}:${id}`
