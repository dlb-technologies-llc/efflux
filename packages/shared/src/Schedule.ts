/**
 * Scheduled-job contract schemas. Job *creation* happens exclusively through
 * the model calling a `create_scheduled_job` tool, approved via the existing
 * `/approve` endpoint — there is no `CreateScheduledJobRequest` on the HTTP
 * contract. The HTTP surface for scheduling is read-only: list, delete, and
 * a single job's most recent run (its captured stdout/stderr — a run's
 * actual output is otherwise generated and immediately discarded, visible
 * nowhere). Per-job outcome-notification config (`JobNotifyConfig`) likewise
 * rides on the `create_scheduled_job` tool rather than any new HTTP surface,
 * as do the retry policy (`JobRetryConfig`) and the outcome-chain targets
 * (`onSuccessJobId`/`onFailureJobId`) — the HTTP surface remains read-only.
 *
 * @module
 */
import { Schema } from "effect"
import { NonNegativeInt, SafeId, SafeName } from "./Schemas.ts"

/** Which channel a scheduled-job outcome notification is delivered on. `slack` POSTs a Slack Incoming Webhook (also usable as a generic `{text}` webhook); `email` uses Cloudflare's Email Service `send_email` binding. */
export const NotifyChannel = Schema.Literals(["slack", "email"])

/** When a notification fires: `failure` only on a non-zero/errored run, `always` on every completed run. */
export const NotifyFilter = Schema.Literals(["failure", "always"])

/**
 * Per-job outcome-notification config, supplied at scheduling time via the
 * `create_scheduled_job` tool and stored on the job. A plain `Schema.Struct`
 * (NOT a `Schema.Class`) on purpose: the tool decodes this parameter to its
 * Type side, and that decoded value is forwarded verbatim across the DO RPC
 * fence into `createScheduledJob` — a `Schema.Class` INSTANCE would throw
 * `DataCloneError` at the `structuredClone` boundary (see ISSUES.md
 * "Schema.Class cannot cross a Cloudflare Durable Object RPC boundary"),
 * while a Struct decodes to a genuinely plain, fence-safe object. Flat (no
 * discriminated union) so it stays robust in the model-facing tool JSON
 * schema: the model fills `slackUrlSecret` for `slack` or `emailTo` for
 * `email`. `slackUrlSecret` names a session secret holding the webhook URL
 * (the URL is a bearer capability — never stored in plaintext config);
 * `emailTo` is the recipient address (must be a verified Email Routing
 * destination on the account).
 */
export const JobNotifyConfig = Schema.Struct({
  channel: NotifyChannel,
  on: NotifyFilter,
  slackUrlSecret: Schema.optionalKey(SafeName),
  emailTo: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(320))),
})

/** Decoded shape of `JobNotifyConfig` — plain object, fence-safe. */
export type JobNotify = typeof JobNotifyConfig.Type

/**
 * Per-job retry-on-failure policy, supplied at scheduling time via the
 * `create_scheduled_job` tool and stored on the job. A plain `Schema.Struct`
 * (NOT a `Schema.Class`) on purpose, for the same fence-safety reason as
 * `JobNotifyConfig` above: the decoded value crosses the DO RPC fence and a
 * class instance would throw `DataCloneError` at the `structuredClone`
 * boundary. `maxAttempts` counts TOTAL tries per firing cycle (e.g. 3 = the
 * initial run plus up to 2 retries); `backoffSeconds` is the fixed delay
 * between tries. Manual "run now" runs never retry.
 */
export const JobRetryConfig = Schema.Struct({
  maxAttempts: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 5 })),
  backoffSeconds: Schema.Int.check(Schema.isBetween({ minimum: 10, maximum: 3600 })),
})

/** Decoded shape of `JobRetryConfig` — plain object, fence-safe. */
export type JobRetry = typeof JobRetryConfig.Type

/**
 * A single scheduled job as surfaced to a caller (list endpoint / FE panel).
 * The job's cadence is described by a cron `schedule` string (server-generated
 * from a previously-validated expression), not a daily hour/minute pair; a
 * loose `Schema.String` on this read path stays forward-compatible. `paused`
 * reports whether the job is currently paused — a paused job stops firing while
 * its config is retained, so it can be resumed later. `notify` is a human label
 * (e.g. `"slack · on failure"`) present only when the job has notifications
 * configured; `retry` and `chain` are the same kind of DO-formatted human
 * labels for the retry policy and outcome-chain targets.
 */
export class ScheduledJobSummary extends Schema.Class<ScheduledJobSummary>("ScheduledJobSummary")({
  id: SafeId,
  description: Schema.String,
  entrypointCommand: Schema.String,
  schedule: Schema.String,
  nextRunAt: NonNegativeInt,
  approvedAt: NonNegativeInt,
  lastRunStatus: Schema.optionalKey(Schema.String),
  notify: Schema.optionalKey(Schema.String),
  paused: Schema.Boolean,
  /** DO-formatted human label for the retry policy (e.g. `up to 3 tries · 300s apart`), present only when the job has a retry policy. */
  retry: Schema.optionalKey(Schema.String),
  /** DO-formatted human label for the outcome-chain targets (e.g. `on success → nightly report`; a deleted target renders `(missing)`), present only when the job has chain targets. */
  chain: Schema.optionalKey(Schema.String),
  /** Absent = a normally scheduled (cron) job; `true` = a chain-only job that has NO schedule of its own and runs ONLY when another job's outcome triggers it — its `schedule` field is the empty string and `nextRunAt` is the dormant sentinel `0`, neither of which should be rendered as a real schedule/time. */
  triggered: Schema.optionalKey(Schema.Boolean),
}) {}

/** Envelope for the scheduled-job list endpoint. */
export class ScheduledJobListResponse extends Schema.Class<ScheduledJobListResponse>("ScheduledJobListResponse")({
  jobs: Schema.Array(ScheduledJobSummary),
}) {}

/** One scheduled job run's captured output — truncated the same way the DO stores it (2000 chars each). */
export class ScheduledJobRunDetail extends Schema.Class<ScheduledJobRunDetail>("ScheduledJobRunDetail")({
  startedAt: NonNegativeInt,
  finishedAt: NonNegativeInt,
  exitCode: Schema.Int,
  stdoutExcerpt: Schema.String,
  stderrExcerpt: Schema.String,
}) {}

/** Envelope for the last-run endpoint; `run` is null when the job hasn't fired yet. */
export class ScheduledJobRunResponse extends Schema.Class<ScheduledJobRunResponse>("ScheduledJobRunResponse")({
  run: Schema.NullOr(ScheduledJobRunDetail),
}) {}

/** Envelope for the run-history endpoint; `runs` holds the job's stored runs, most recent first, capped at the DO's per-job retention limit — empty when the job hasn't fired yet. */
export class ScheduledJobRunListResponse extends Schema.Class<ScheduledJobRunListResponse>("ScheduledJobRunListResponse")({
  runs: Schema.Array(ScheduledJobRunDetail),
}) {}
