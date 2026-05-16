import { Schema as Schema } from "effect"
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "effect/unstable/httpapi"
import { AgentError, NotFoundError } from "./Errors.ts"
import {
  HistoryResponse,
  PromptRequest,
  PromptResponse,
  SubagentTaskRequest,
  SubagentTaskResponse,
} from "./Schemas.ts"

// Session keys are URL path segments backed by DO ids; constrain to safe
// characters to prevent path-traversal-like attacks via `:name` / `:id`.
const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/
const SafeId = Schema.String.pipe(
  Schema.refine((s): s is string => SAFE_ID_PATTERN.test(s), {
    title: "SafeId",
    description: "alphanumeric, hyphen, underscore; 1-128 chars",
  }),
)

const AgentParams = Schema.Struct({
  name: SafeId,
  id: SafeId,
})

const prompt = HttpApiEndpoint.post("prompt", "/agents/:name/:id", {
  params: AgentParams,
  payload: PromptRequest,
  success: PromptResponse,
  error: AgentError,
})

const history = HttpApiEndpoint.get("history", "/agents/:name/:id", {
  params: AgentParams,
  success: HistoryResponse,
  error: NotFoundError,
})

const reset = HttpApiEndpoint.delete("reset", "/agents/:name/:id", {
  params: AgentParams,
  success: Schema.Void,
  error: AgentError,
})

const stream = HttpApiEndpoint.post("stream", "/agents/:name/:id/stream", {
  params: AgentParams,
  payload: PromptRequest,
  success: HttpApiSchema.NoContent,
  error: AgentError,
})

const task = HttpApiEndpoint.post("task", "/tasks", {
  payload: SubagentTaskRequest,
  success: SubagentTaskResponse,
  error: AgentError,
})

export const AgentGroup = HttpApiGroup.make("agents")
  .add(prompt)
  .add(history)
  .add(reset)
  .add(stream)
  .add(task)

export class AgentApi extends HttpApi.make("agent-api").add(AgentGroup) {}
