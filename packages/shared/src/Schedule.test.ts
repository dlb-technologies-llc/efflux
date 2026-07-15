/**
 * Round-trip characterization of the scheduled-job contract schemas: encode →
 * decode → re-encode must be stable, pinning today's shape so a later change
 * to `ScheduledJobSummary`'s bounded numeric fields (`HourUtc`/`MinuteUtc` via
 * `NonNegativeInt`) or `ScheduledJobListResponse`'s envelope breaks the test.
 *
 * `ScheduledJobSummary.id` is a `SafeId` — a regex-refined schema — so per
 * the project convention (see `Journal.test.ts`) it is NOT property-tested
 * via `Schema.toArbitrary` (the generator would exhaust FastCheck's
 * `.filter`); instead both schemas are pinned with fixed representative
 * values built from the real constructors.
 *
 * @module
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { ScheduledJobListResponse, ScheduledJobRunDetail, ScheduledJobRunResponse, ScheduledJobSummary } from "./Schedule.ts"

const assertStable = <T, E>(schema: Schema.Codec<T, E>, value: T) =>
  Effect.gen(function* () {
    const encoded = yield* Schema.encodeEffect(schema)(value)
    const decoded = yield* Schema.decodeEffect(schema)(encoded)
    const reEncoded = yield* Schema.encodeEffect(schema)(decoded)
    expect(reEncoded).toStrictEqual(encoded)
  })

describe("ScheduledJobSummary codec", () => {
  it.effect("pins a summary with lastRunStatus present", () =>
    assertStable(
      ScheduledJobSummary,
      new ScheduledJobSummary({
        id: "job-nightly-report",
        description: "generate nightly report",
        entrypointCommand: "bun run report.ts",
        runAtHourUtc: 6,
        runAtMinuteUtc: 30,
        nextRunAt: 1_700_000_000_000,
        approvedAt: 1_699_000_000_000,
        lastRunStatus: "success",
      }),
    ))

  it.effect("pins a summary with optional lastRunStatus absent", () =>
    assertStable(
      ScheduledJobSummary,
      new ScheduledJobSummary({
        id: "job-never-run",
        description: "first run pending",
        entrypointCommand: "bun run task.ts",
        runAtHourUtc: 0,
        runAtMinuteUtc: 0,
        nextRunAt: 1_700_000_000_000,
        approvedAt: 1_699_000_000_000,
      }),
    ))

  it.effect("pins hour/minute at their upper bounds", () =>
    assertStable(
      ScheduledJobSummary,
      new ScheduledJobSummary({
        id: "job-late-run",
        description: "last minute of the day",
        entrypointCommand: "bun run late.ts",
        runAtHourUtc: 23,
        runAtMinuteUtc: 59,
        nextRunAt: 1_700_000_000_000,
        approvedAt: 1_699_000_000_000,
        lastRunStatus: "failed",
      }),
    ))
})

describe("ScheduledJobListResponse codec", () => {
  it.effect("pins an empty job list", () =>
    assertStable(ScheduledJobListResponse, new ScheduledJobListResponse({ jobs: [] })))

  it.effect("pins a job list with multiple entries", () =>
    assertStable(
      ScheduledJobListResponse,
      new ScheduledJobListResponse({
        jobs: [
          new ScheduledJobSummary({
            id: "job-one",
            description: "first job",
            entrypointCommand: "bun run one.ts",
            runAtHourUtc: 6,
            runAtMinuteUtc: 30,
            nextRunAt: 1_700_000_000_000,
            approvedAt: 1_699_000_000_000,
            lastRunStatus: "success",
          }),
          new ScheduledJobSummary({
            id: "job-two",
            description: "second job",
            entrypointCommand: "bun run two.ts",
            runAtHourUtc: 12,
            runAtMinuteUtc: 0,
            nextRunAt: 1_700_100_000_000,
            approvedAt: 1_699_100_000_000,
          }),
        ],
      }),
    ))
})

describe("ScheduledJobRunDetail codec", () => {
  it.effect("pins a successful run with both streams present", () =>
    assertStable(
      ScheduledJobRunDetail,
      new ScheduledJobRunDetail({
        startedAt: 1_700_000_000_000,
        finishedAt: 1_700_000_001_500,
        exitCode: 0,
        stdoutExcerpt: '{"weather":"clear"}',
        stderrExcerpt: "",
      }),
    ))

  it.effect("pins a failed run (negative sentinel exit code)", () =>
    assertStable(
      ScheduledJobRunDetail,
      new ScheduledJobRunDetail({
        startedAt: 1_700_000_000_000,
        finishedAt: 1_700_000_000_800,
        exitCode: -1,
        stdoutExcerpt: "",
        stderrExcerpt: "runner restore failed 500",
      }),
    ))
})

describe("ScheduledJobRunResponse codec", () => {
  it.effect("pins a job that hasn't run yet (null run)", () =>
    assertStable(ScheduledJobRunResponse, new ScheduledJobRunResponse({ run: null })))

  it.effect("pins a job with a recorded run", () =>
    assertStable(
      ScheduledJobRunResponse,
      new ScheduledJobRunResponse({
        run: new ScheduledJobRunDetail({
          startedAt: 1_700_000_000_000,
          finishedAt: 1_700_000_001_500,
          exitCode: 0,
          stdoutExcerpt: "ok",
          stderrExcerpt: "",
        }),
      }),
    ))
})
