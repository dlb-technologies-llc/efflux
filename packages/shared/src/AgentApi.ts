import { Schema } from "effect"
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "effect/unstable/httpapi"
import { AgentConfig, ResolvedConfig } from "./Config.ts"
import {
  AgentError,
  ApprovalConflictError,
  ApprovalNotFoundError,
  RoleNotFoundError,
  SkillNotFoundError,
} from "./Errors.ts"
import { JournalResponse, SessionsResponse } from "./Journal.ts"
import { ToolsResponse } from "./Meta.ts"
import {
  ApprovalDecision,
  HistoryResponse,
  PromptRequest,
  PromptResponse,
  SafeId,
  SubagentTaskRequest,
  SubagentTaskResponse,
} from "./Schemas.ts"
import { SchemaErrorMiddleware } from "./SchemaErrorMiddleware.ts"
import {
  PutSkillRequest,
  SkillContentResponse,
  SkillListResponse,
} from "./Skills.ts"

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

/** Read the session's effective (resolved) config — stored overrides merged over Defaults. */
const getConfig = HttpApiEndpoint.get("getConfig", "/agents/:name/:id/config", {
  params: AgentParams,
  success: ResolvedConfig,
})

/** Replace the session's config overrides wholesale; returns the new effective config. */
const putConfig = HttpApiEndpoint.put("putConfig", "/agents/:name/:id/config", {
  params: AgentParams,
  payload: AgentConfig,
  success: ResolvedConfig,
})

/** Every skill in R2, name plus description. */
const listSkills = HttpApiEndpoint.get("listSkills", "/skills", {
  success: SkillListResponse,
  error: AgentError,
})

/** One skill's full markdown by name. */
const getSkill = HttpApiEndpoint.get("getSkill", "/skills/:name", {
  params: Schema.Struct({ name: SafeId }),
  success: SkillContentResponse,
  error: [AgentError, SkillNotFoundError],
})

/** Upsert a skill's markdown by name. */
const putSkill = HttpApiEndpoint.put("putSkill", "/skills/:name", {
  params: Schema.Struct({ name: SafeId }),
  payload: PutSkillRequest,
  success: SkillContentResponse,
  error: AgentError,
})

/** Remove a skill by name. */
const deleteSkill = HttpApiEndpoint.delete("deleteSkill", "/skills/:name", {
  params: Schema.Struct({ name: SafeId }),
  success: Schema.Void,
  error: [AgentError, SkillNotFoundError],
})

/** Static toolkit inventory for the Tools panel — no params, no declared errors. */
const tools = HttpApiEndpoint.get("tools", "/meta/tools", {
  success: ToolsResponse,
})

/** Meta/introspection endpoints. */
export const MetaGroup = HttpApiGroup.make("meta").add(tools)

/** All skill CRUD endpoints grouped. */
export const SkillsGroup = HttpApiGroup.make("skills")
  .add(listSkills)
  .add(getSkill)
  .add(putSkill)
  .add(deleteSkill)

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
  .add(getConfig)
  .add(putConfig)

/** The app's single HttpApi; `.middleware` attaches after `.add(AgentGroup)` so per `HttpApi.middleware` semantics it applies to every endpoint in the group. */
export class AgentApi extends HttpApi.make("agent-api")
  .add(AgentGroup)
  .add(SkillsGroup)
  .add(MetaGroup)
  .middleware(SchemaErrorMiddleware) {}
