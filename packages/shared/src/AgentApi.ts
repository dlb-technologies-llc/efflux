import { Schema } from "effect"
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "effect/unstable/httpapi"
import {
  AgentError,
  ApprovalConflictError,
  ApprovalNotFoundError,
  RoleNotFoundError,
  SkillNotFoundError,
} from "./Errors.ts"
import { JournalResponse, SessionsResponse } from "./Journal.ts"
import {
  ApprovalDecision,
  HistoryResponse,
  PromptRequest,
  PromptResponse,
  SubagentTaskRequest,
  SubagentTaskResponse,
} from "./Schemas.ts"
import { SchemaErrorMiddleware } from "./SchemaErrorMiddleware.ts"

const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/
/** Safe identifier for `:name` / `:id` path segments backed by DO ids — constrains characters to prevent path-traversal-style attacks. */
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
  error: [AgentError, SkillNotFoundError, RoleNotFoundError],
})

const history = HttpApiEndpoint.get("history", "/agents/:name/:id", {
  params: AgentParams,
  success: HistoryResponse,
})

const reset = HttpApiEndpoint.delete("reset", "/agents/:name/:id", {
  params: AgentParams,
  success: Schema.Void,
  error: AgentError,
})

const stream = HttpApiEndpoint.post("stream", "/agents/:name/:id/stream", {
  params: AgentParams,
  payload: PromptRequest,
  success: Schema.String.pipe(
    HttpApiSchema.asText({ contentType: "text/event-stream" }),
  ),
  error: [AgentError, SkillNotFoundError, RoleNotFoundError],
})

const approve = HttpApiEndpoint.post(
  "approve",
  "/agents/:name/:id/approve/:eventId",
  {
    params: Schema.Struct({
      name: SafeId,
      id: SafeId,
      eventId: Schema.NumberFromString.pipe(
        Schema.check(Schema.isGreaterThanOrEqualTo(0)),
      ),
    }),
    payload: ApprovalDecision,
    success: Schema.String.pipe(
      HttpApiSchema.asText({ contentType: "text/event-stream" }),
    ),
    error: [
      AgentError,
      ApprovalNotFoundError,
      ApprovalConflictError,
      SkillNotFoundError,
      RoleNotFoundError,
    ],
  },
)

const task = HttpApiEndpoint.post("task", "/tasks", {
  payload: SubagentTaskRequest,
  success: SubagentTaskResponse,
  error: [AgentError, SkillNotFoundError, RoleNotFoundError],
})

/** Paginated read of the session's append-only event journal — `after` is an exclusive seq cursor, `limit` clamps to 1..500 server-side (default 100). */
const journal = HttpApiEndpoint.get("journal", "/agents/:name/:id/journal", {
  params: AgentParams,
  query: {
    after: Schema.optionalKey(Schema.NumberFromString),
    limit: Schema.optionalKey(Schema.NumberFromString),
  },
  success: JournalResponse,
})

/** Session registry — every session that has ever received a user message, most recently active first. */
const sessions = HttpApiEndpoint.get("sessions", "/agents", {
  success: SessionsResponse,
})

/** All agent endpoints grouped. */
export const AgentGroup = HttpApiGroup.make("agents")
  .add(prompt)
  .add(history)
  .add(reset)
  .add(stream)
  .add(approve)
  .add(task)
  .add(journal)
  .add(sessions)

/** The app's single HttpApi; `.middleware` attaches after `.add(AgentGroup)` so per `HttpApi.middleware` semantics it applies to every endpoint in the group. */
export class AgentApi extends HttpApi.make("agent-api")
  .add(AgentGroup)
  .middleware(SchemaErrorMiddleware) {}
