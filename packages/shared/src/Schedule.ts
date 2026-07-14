/**
 * Scheduled-job contract schemas. Job *creation* happens exclusively through
 * the model calling a `create_scheduled_job` tool in a later wave, approved
 * via the existing `/approve` endpoint — there is no `CreateScheduledJobRequest`
 * on the HTTP contract. The only new HTTP surface for scheduling is list +
 * delete (for a frontend panel in a later wave), so this module carries just
 * the read-side shapes.
 *
 * @module
 */
import { Schema } from "effect"
import { NonNegativeInt, SafeId } from "./Schemas.ts"

const HourUtc = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThan(24))
const MinuteUtc = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThan(60))

/** A single scheduled job as surfaced to a caller (list endpoint / FE panel). */
export class ScheduledJobSummary extends Schema.Class<ScheduledJobSummary>("ScheduledJobSummary")({
  id: SafeId,
  description: Schema.String,
  entrypointCommand: Schema.String,
  runAtHourUtc: HourUtc,
  runAtMinuteUtc: MinuteUtc,
  nextRunAt: NonNegativeInt,
  approvedAt: NonNegativeInt,
  lastRunStatus: Schema.optionalKey(Schema.String),
}) {}

/** Envelope for the scheduled-job list endpoint. */
export class ScheduledJobListResponse extends Schema.Class<ScheduledJobListResponse>("ScheduledJobListResponse")({
  jobs: Schema.Array(ScheduledJobSummary),
}) {}
