import * as Schema from "effect/Schema"
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
} from "./Schemas.ts"

const AgentParams = Schema.Struct({
  name: Schema.String,
  id: Schema.String,
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

export const AgentGroup = HttpApiGroup.make("agents")
  .add(prompt)
  .add(history)
  .add(reset)
  .add(stream)

export class AgentApi extends HttpApi.make("agent-api").add(AgentGroup) {}
