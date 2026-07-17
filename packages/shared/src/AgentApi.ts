import { Schema } from "effect"
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "effect/unstable/httpapi"
import { AgentConfig, ResolvedConfig, SetBudgetRequest, SetToolRuleRequest } from "./Config.ts"
import {
  AgentError,
  ApprovalConflictError,
  ApprovalNotFoundError,
  BudgetExceededError,
  RoleNotFoundError,
  SkillNotFoundError,
} from "./Errors.ts"
import { JournalResponse, SessionArchive, SessionsResponse } from "./Journal.ts"
import { ArchiveListResponse } from "./Archives.ts"
import { SessionUsage } from "./Usage.ts"
import { ChatCompletionRequest, ModelsResponse } from "./OpenAi.ts"
import { ToolsResponse } from "./Meta.ts"
import {
  KnowledgeItemResponse,
  KnowledgeListResponse,
  PutKnowledgeRequest,
} from "./Knowledge.ts"
import {
  ApprovalDecision,
  HistoryResponse,
  PromptRequest,
  PromptResponse,
  SafeId,
  SafeName,
  SubagentTaskRequest,
  SubagentTaskResponse,
} from "./Schemas.ts"
import { AuthMiddleware } from "./AuthMiddleware.ts"
import { SchemaErrorMiddleware } from "./SchemaErrorMiddleware.ts"
import {
  PutSkillRequest,
  SkillContentResponse,
  SkillListResponse,
} from "./Skills.ts"
import { PutSecretRequest, SecretListResponse, SecretSummary } from "./Secrets.ts"
import { ScheduledJobListResponse, ScheduledJobRunListResponse, ScheduledJobRunResponse } from "./Schedule.ts"
import { MAX_UPLOAD_BYTES, UploadResponse, WorkspaceFilename } from "./Files.ts"

/** Exclusive seq cursor decoded from a query or path string — a non-negative integer matching the journal's SQLite `seq` column. Single source for every `?after=` cursor and the approve path's `eventId`. */
const SeqFromString = Schema.NumberFromString.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
)

/** Archive close-timestamp decoded from the path — a non-negative integer epoch-ms, the third segment of the `archives/<name>/<id>/<closedAt>/journal.json` key. */
const ClosedAtFromString = Schema.NumberFromString.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
)

const AgentParams = Schema.Struct({
  name: SafeId,
  id: SafeId,
})

const prompt = HttpApiEndpoint.post("prompt", "/agents/:name/:id", {
  params: AgentParams,
  payload: PromptRequest,
  success: PromptResponse,
  error: [AgentError, SkillNotFoundError, RoleNotFoundError, BudgetExceededError],
})

const history = HttpApiEndpoint.get("history", "/agents/:name/:id", {
  params: AgentParams,
  success: HistoryResponse,
})

const reset = HttpApiEndpoint.delete("reset", "/agents/:name/:id", {
  params: AgentParams,
  query: {
    mode: Schema.optionalKey(Schema.Literals(["reset", "archive", "purge"])),
  },
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
      eventId: SeqFromString,
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
    after: Schema.optionalKey(SeqFromString),
    limit: Schema.optionalKey(Schema.NumberFromString),
  },
  success: JournalResponse,
})

/** Reattach to a session's live turn as SSE — replays journaled frames after the resume cursor (header `Last-Event-ID`, else `?after=`, else the latest turn in full) then live-tails until the turn ends. No payload (GET); the handler owns cursor precedence. */
const attach = HttpApiEndpoint.get("attach", "/agents/:name/:id/attach", {
  params: AgentParams,
  headers: Schema.Struct({
    "last-event-id": Schema.optionalKey(SeqFromString),
  }),
  query: {
    after: Schema.optionalKey(SeqFromString),
  },
  success: Schema.String.pipe(
    HttpApiSchema.asText({ contentType: "text/event-stream" }),
  ),
})

/** Session registry — every session that has ever received a user message, most recently active first. */
const sessions = HttpApiEndpoint.get("sessions", "/agents", {
  success: SessionsResponse,
})

/** Cumulative session spend + resolved caps + whether either ceiling is tripped. */
const usage = HttpApiEndpoint.get("usage", "/agents/:name/:id/usage", {
  params: AgentParams,
  success: SessionUsage,
  error: AgentError,
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

/** Flip a single tool's session gate decision, merged into the stored overrides; returns the new effective config. */
const putToolRule = HttpApiEndpoint.put(
  "putToolRule",
  "/agents/:name/:id/config/rules/:tool",
  {
    params: Schema.Struct({ name: SafeId, id: SafeId, tool: SafeName }),
    payload: SetToolRuleRequest,
    success: ResolvedConfig,
  },
)

/** Set or clear the session's token/cost budget, merged into the stored overrides; returns the new effective config. Impossible ceilings are rejected by the `SetBudgetRequest` decode. */
const putBudget = HttpApiEndpoint.put("putBudget", "/agents/:name/:id/config/budget", {
  params: AgentParams,
  payload: SetBudgetRequest,
  success: ResolvedConfig,
})

/** Every skill in R2, name plus description. */
const listSkills = HttpApiEndpoint.get("listSkills", "/skills", {
  success: SkillListResponse,
  error: AgentError,
})

/** One skill's full markdown by name. */
const getSkill = HttpApiEndpoint.get("getSkill", "/skills/:name", {
  params: Schema.Struct({ name: SafeName }),
  success: SkillContentResponse,
  error: [AgentError, SkillNotFoundError],
})

/** Upsert a skill's markdown by name. */
const putSkill = HttpApiEndpoint.put("putSkill", "/skills/:name", {
  params: Schema.Struct({ name: SafeName }),
  payload: PutSkillRequest,
  success: SkillContentResponse,
  error: AgentError,
})

/** Remove a skill by name. */
const deleteSkill = HttpApiEndpoint.delete("deleteSkill", "/skills/:name", {
  params: Schema.Struct({ name: SafeName }),
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
  .middleware(AuthMiddleware)

/** Every knowledge item with status, for polling until `completed`. */
const listKnowledge = HttpApiEndpoint.get("listKnowledge", "/knowledge", {
  success: KnowledgeListResponse,
  error: AgentError,
})

/** Upsert a knowledge document's text by name. */
const putKnowledge = HttpApiEndpoint.put("putKnowledge", "/knowledge/:name", {
  params: Schema.Struct({ name: SafeName }),
  payload: PutKnowledgeRequest,
  success: KnowledgeItemResponse,
  error: AgentError,
})

/** All knowledge endpoints grouped. */
export const KnowledgeGroup = HttpApiGroup.make("knowledge")
  .add(listKnowledge)
  .add(putKnowledge)
  .middleware(AuthMiddleware)

/** Upsert a session secret by key; the value is write-only and never echoed back. */
const putSecret = HttpApiEndpoint.put("putSecret", "/agents/:name/:id/secrets/:key", {
  params: Schema.Struct({ name: SafeId, id: SafeId, key: SafeName }),
  payload: PutSecretRequest,
  success: SecretSummary,
  error: AgentError,
})

/** Every secret key configured for a session, without values. */
const listSecrets = HttpApiEndpoint.get("listSecrets", "/agents/:name/:id/secrets", {
  params: AgentParams,
  success: SecretListResponse,
  error: AgentError,
})

/** Delete a single stored secret by key. Idempotent — deleting an absent key still succeeds with no error, mirroring `deleteScheduledJob`. */
const deleteSecret = HttpApiEndpoint.delete("deleteSecret", "/agents/:name/:id/secrets/:key", {
  params: Schema.Struct({ name: SafeId, id: SafeId, key: SafeName }),
  success: Schema.Void,
  error: AgentError,
})

/** All secrets CRUD endpoints grouped. */
export const SecretsGroup = HttpApiGroup.make("secrets")
  .add(putSecret)
  .add(listSecrets)
  .add(deleteSecret)
  .middleware(AuthMiddleware)

/** Every scheduled job for a session. */
const listScheduledJobs = HttpApiEndpoint.get("listScheduledJobs", "/agents/:name/:id/schedule", {
  params: AgentParams,
  success: ScheduledJobListResponse,
  error: AgentError,
})

/** Cancel a scheduled job by id. */
const deleteScheduledJob = HttpApiEndpoint.delete("deleteScheduledJob", "/agents/:name/:id/schedule/:jobId", {
  params: Schema.Struct({ name: SafeId, id: SafeId, jobId: SafeId }),
  success: Schema.Void,
  error: AgentError,
})

/** A scheduled job's full run history — every run the DO still retains, most recent first (its captured stdout/stderr per run). `runs` is empty when the job hasn't fired yet. Subsumes the last run (it is `runs[0]`). */
const listRuns = HttpApiEndpoint.get("listRuns", "/agents/:name/:id/schedule/:jobId/runs", {
  params: Schema.Struct({ name: SafeId, id: SafeId, jobId: SafeId }),
  success: ScheduledJobRunListResponse,
  error: AgentError,
})

/** Pause a scheduled job — it stops firing while retaining all config. Idempotent. */
const pauseScheduledJob = HttpApiEndpoint.post("pauseScheduledJob", "/agents/:name/:id/schedule/:jobId/pause", {
  params: Schema.Struct({ name: SafeId, id: SafeId, jobId: SafeId }),
  success: Schema.Void,
  error: AgentError,
})

/** Resume a paused scheduled job — it fires again on its existing schedule (next upcoming slot; missed occurrences are skipped, no immediate catch-up fire). Idempotent. */
const resumeScheduledJob = HttpApiEndpoint.post("resumeScheduledJob", "/agents/:name/:id/schedule/:jobId/resume", {
  params: Schema.Struct({ name: SafeId, id: SafeId, jobId: SafeId }),
  success: Schema.Void,
  error: AgentError,
})

/** Fire a scheduled job immediately, independent of its schedule — it runs on a fresh Runner through the same path the alarm uses, records a run, and returns that run's captured output. Does NOT reschedule the job or change its paused state. `run` is null when the job id no longer exists OR a run is already in flight for it (a manual "run now" or an alarm fire holds the per-job guard). */
const runScheduledJobNow = HttpApiEndpoint.post("runScheduledJobNow", "/agents/:name/:id/schedule/:jobId/run-now", {
  params: Schema.Struct({ name: SafeId, id: SafeId, jobId: SafeId }),
  success: ScheduledJobRunResponse,
  error: AgentError,
})

/** All scheduled-job endpoints grouped. */
export const ScheduleGroup = HttpApiGroup.make("schedule")
  .add(listScheduledJobs)
  .add(deleteScheduledJob)
  .add(listRuns)
  .add(pauseScheduledJob)
  .add(resumeScheduledJob)
  .add(runScheduledJobNow)
  .middleware(AuthMiddleware)

/** The archived-session corpus index — every `journal.json` under `archives/`, newest close first. */
const listArchives = HttpApiEndpoint.get("listArchives", "/archives", {
  success: ArchiveListResponse,
  error: AgentError,
})

/** One archived session's full journal by `name` + `id` + `closedAt` (the three key segments). */
const getArchive = HttpApiEndpoint.get("getArchive", "/archives/:name/:id/:closedAt", {
  params: Schema.Struct({ name: SafeId, id: SafeId, closedAt: ClosedAtFromString }),
  success: SessionArchive,
  error: AgentError,
})

/** Read-only archived-corpus endpoints grouped. */
export const ArchivesGroup = HttpApiGroup.make("archives")
  .add(listArchives)
  .add(getArchive)
  .middleware(AuthMiddleware)

/** Raw binary upload body, capped at MAX_UPLOAD_BYTES; the size check runs on decode server-side, so an over-cap upload fails before touching the DO. Encoded side is `Uint8Array` (required by `asUint8Array`). */
const UploadBody = Schema.Uint8Array.pipe(
  Schema.check(Schema.isMaxLength(MAX_UPLOAD_BYTES)),
  HttpApiSchema.asUint8Array(),
)

/** Upload a file into the session's container `/workspace`; raw request body is the file bytes, `?filename=` names the destination (bare filename, lands at `/workspace/<filename>`). */
const uploadFile = HttpApiEndpoint.post("uploadFile", "/agents/:name/:id/files", {
  params: AgentParams,
  query: { filename: WorkspaceFilename },
  payload: UploadBody,
  success: UploadResponse,
  error: AgentError,
})

/** Session workspace file endpoints grouped. */
export const FilesGroup = HttpApiGroup.make("files")
  .add(uploadFile)
  .middleware(AuthMiddleware)

/** All agent endpoints grouped. */
export const AgentGroup = HttpApiGroup.make("agents")
  .add(prompt)
  .add(history)
  .add(reset)
  .add(stream)
  .add(approve)
  .add(task)
  .add(journal)
  .add(attach)
  .add(sessions)
  .add(usage)
  .add(getConfig)
  .add(putConfig)
  .add(putToolRule)
  .add(putBudget)
  .middleware(AuthMiddleware)

/** OpenAI-compatible chat completions. Success is declared as text because the handler returns a raw `HttpServerResponse` — JSON for non-stream, SSE for `stream:true`. */
const chatCompletions = HttpApiEndpoint.post("chatCompletions", "/v1/chat/completions", {
  payload: ChatCompletionRequest,
  success: Schema.String.pipe(
    HttpApiSchema.asText({ contentType: "text/event-stream" }),
  ),
  error: [AgentError, SkillNotFoundError, RoleNotFoundError],
})

/** OpenAI-compatible model list — every registered session as `agent:<name>:<id>`. */
const listModels = HttpApiEndpoint.get("listModels", "/v1/models", {
  success: ModelsResponse,
})

/** OpenAI-compatible facade endpoints grouped. */
export const V1Group = HttpApiGroup.make("v1")
  .add(chatCompletions)
  .add(listModels)
  .middleware(AuthMiddleware)

/** The app's single HttpApi; `.middleware` is chained last, so per `HttpApi.middleware` semantics it applies to every endpoint already added across all groups — a group added after this call would not receive it. */
export class AgentApi extends HttpApi.make("agent-api")
  .add(AgentGroup)
  .add(SkillsGroup)
  .add(V1Group)
  .add(KnowledgeGroup)
  .add(MetaGroup)
  .add(SecretsGroup)
  .add(ScheduleGroup)
  .add(ArchivesGroup)
  .add(FilesGroup)
  .middleware(SchemaErrorMiddleware) {}
