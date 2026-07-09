import { Result, Schema } from "effect"
import { SafeId } from "./Schemas.ts"

/** One OpenAI chat message. Only `role`+`content` are consumed; `content` may be null on assistant tool-call turns some clients replay. */
export class ChatMessage extends Schema.Class<ChatMessage>("ChatMessage")({
  role: Schema.Literals(["system", "user", "assistant", "tool"]),
  content: Schema.NullOr(Schema.String),
}) {}

/** OpenAI `POST /v1/chat/completions` request body. Unlisted fields (temperature, top_p, tools, …) are stripped on decode. `model` is the session address `agent:<name>:<id>`. */
export class ChatCompletionRequest extends Schema.Class<ChatCompletionRequest>("ChatCompletionRequest")({
  model: Schema.String.check(Schema.isMaxLength(512)),
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

const decodeSafeId = Schema.decodeUnknownResult(SafeId)

/** Parse a `model` field into a session address, or `undefined` when it is not a well-formed `agent:<name>:<id>`; `name`/`id` are validated through the `SafeId` schema (no re-listed char class). */
export const parseAgentModel = (model: string): { name: string; id: string } | undefined => {
  const parts = model.split(":")
  if (parts.length !== 3 || parts[0] !== "agent") return undefined
  const name = decodeSafeId(parts[1])
  const id = decodeSafeId(parts[2])
  return Result.isSuccess(name) && Result.isSuccess(id)
    ? { name: name.success, id: id.success }
    : undefined
}

/** Build the `agent:<name>:<id>` model id from a session's name+id. */
export const formatAgentModel = (name: string, id: string): string => `agent:${name}:${id}`
