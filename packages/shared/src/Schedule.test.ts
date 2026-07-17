/**
 * Round-trip characterization of the scheduled-job contract schemas: encode →
 * decode → re-encode must be stable, pinning today's shape so a later change
 * to `ScheduledJobSummary`'s cron `schedule` string field or
 * `ScheduledJobListResponse`'s envelope breaks the test.
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
import { JobNotifyConfig, NotifyChannel, NotifyFilter, ScheduledJobListResponse, ScheduledJobRunDetail, ScheduledJobRunListResponse, ScheduledJobRunResponse, ScheduledJobSummary } from "./Schedule.ts"

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
        schedule: "30 6 * * *",
        nextRunAt: 1_700_000_000_000,
        approvedAt: 1_699_000_000_000,
        lastRunStatus: "success",
        paused: false,
      }),
    ))

  it.effect("pins a summary with optional lastRunStatus absent", () =>
    assertStable(
      ScheduledJobSummary,
      new ScheduledJobSummary({
        id: "job-never-run",
        description: "first run pending",
        entrypointCommand: "bun run task.ts",
        schedule: "0 0 * * *",
        nextRunAt: 1_700_000_000_000,
        approvedAt: 1_699_000_000_000,
        paused: false,
      }),
    ))

  it.effect("pins a summary with a sub-hourly schedule", () =>
    assertStable(
      ScheduledJobSummary,
      new ScheduledJobSummary({
        id: "job-late-run",
        description: "polls every ten minutes",
        entrypointCommand: "bun run late.ts",
        schedule: "*/10 * * * *",
        nextRunAt: 1_700_000_000_000,
        approvedAt: 1_699_000_000_000,
        lastRunStatus: "failed",
        paused: false,
      }),
    ))

  it.effect("pins a paused summary", () =>
    assertStable(
      ScheduledJobSummary,
      new ScheduledJobSummary({
        id: "job-paused-nightly",
        description: "paused nightly report",
        entrypointCommand: "bun run report.ts",
        schedule: "30 6 * * *",
        nextRunAt: 1_700_000_000_000,
        approvedAt: 1_699_000_000_000,
        lastRunStatus: "success",
        paused: true,
      }),
    ))

  it.effect("pins a summary with the notify label present", () =>
    assertStable(
      ScheduledJobSummary,
      new ScheduledJobSummary({
        id: "job-alerting",
        description: "alerts on failure",
        entrypointCommand: "bun run check.ts",
        schedule: "0 * * * *",
        nextRunAt: 1_700_000_000_000,
        approvedAt: 1_699_000_000_000,
        lastRunStatus: "failed (exit 1)",
        paused: false,
        notify: "slack · on failure",
      }),
    ))
})

describe("JobNotifyConfig codec", () => {
  it.effect("pins a slack config alerting on failure", () =>
    assertStable(JobNotifyConfig, {
      channel: "slack",
      on: "failure",
      slackUrlSecret: "SLACK_ALERT_URL",
    }))

  it.effect("pins a slack config alerting on every run", () =>
    assertStable(JobNotifyConfig, {
      channel: "slack",
      on: "always",
      slackUrlSecret: "OPS_WEBHOOK",
    }))

  it.effect("pins an email config alerting on failure", () =>
    assertStable(JobNotifyConfig, {
      channel: "email",
      on: "failure",
      emailTo: "alerts@example.com",
    }))

  it.effect("pins an email config alerting on every run", () =>
    assertStable(JobNotifyConfig, {
      channel: "email",
      on: "always",
      emailTo: "ops@example.com",
    }))
})

describe("Notify literals codec", () => {
  it.effect("pins the slack channel", () => assertStable(NotifyChannel, "slack"))
  it.effect("pins the email channel", () => assertStable(NotifyChannel, "email"))
  it.effect("pins the failure filter", () => assertStable(NotifyFilter, "failure"))
  it.effect("pins the always filter", () => assertStable(NotifyFilter, "always"))
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
            schedule: "0 9 * * 1-5",
            nextRunAt: 1_700_000_000_000,
            approvedAt: 1_699_000_000_000,
            lastRunStatus: "success",
            paused: false,
          }),
          new ScheduledJobSummary({
            id: "job-two",
            description: "second job",
            entrypointCommand: "bun run two.ts",
            schedule: "0 12 * * *",
            nextRunAt: 1_700_100_000_000,
            approvedAt: 1_699_100_000_000,
            paused: true,
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

describe("ScheduledJobRunListResponse codec", () => {
  it.effect("pins an empty history (no runs yet)", () =>
    assertStable(ScheduledJobRunListResponse, new ScheduledJobRunListResponse({ runs: [] })))

  it.effect("pins a history with a successful and a failed run", () =>
    assertStable(
      ScheduledJobRunListResponse,
      new ScheduledJobRunListResponse({
        runs: [
          new ScheduledJobRunDetail({
            startedAt: 1_700_000_100_000,
            finishedAt: 1_700_000_101_500,
            exitCode: 0,
            stdoutExcerpt: '{"weather":"clear"}',
            stderrExcerpt: "",
          }),
          new ScheduledJobRunDetail({
            startedAt: 1_700_000_000_000,
            finishedAt: 1_700_000_000_800,
            exitCode: -1,
            stdoutExcerpt: "",
            stderrExcerpt: "runner restore failed 500",
          }),
        ],
      }),
    ))
})
