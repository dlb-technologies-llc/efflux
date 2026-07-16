/**
 * Scheduled-job contract schemas. Job *creation* happens exclusively through
 * the model calling a `create_scheduled_job` tool, approved via the existing
 * `/approve` endpoint — there is no `CreateScheduledJobRequest` on the HTTP
 * contract. The HTTP surface for scheduling is read-only: list, delete, and
 * a single job's most recent run (its captured stdout/stderr — a run's
 * actual output is otherwise generated and immediately discarded, visible
 * nowhere).
 *
 * @module
 */
import { Schema } from "effect"
import { NonNegativeInt, SafeId } from "./Schemas.ts"

/**
 * A single scheduled job as surfaced to a caller (list endpoint / FE panel).
 * The job's cadence is described by a cron `schedule` string (server-generated
 * from a previously-validated expression), not a daily hour/minute pair; a
 * loose `Schema.String` on this read path stays forward-compatible. `paused`
 * reports whether the job is currently paused — a paused job stops firing while
 * its config is retained, so it can be resumed later.
 */
export class ScheduledJobSummary extends Schema.Class<ScheduledJobSummary>("ScheduledJobSummary")({
  id: SafeId,
  description: Schema.String,
  entrypointCommand: Schema.String,
  schedule: Schema.String,
  nextRunAt: NonNegativeInt,
  approvedAt: NonNegativeInt,
  lastRunStatus: Schema.optionalKey(Schema.String),
  paused: Schema.Boolean,
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
