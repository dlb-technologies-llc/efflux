import { AgentApi, ScheduledJobListResponse, ScheduledJobRunDetail, ScheduledJobRunListResponse, ScheduledJobRunResponse, ScheduledJobSummary } from "@efflux/shared"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { AgentStub } from "./AgentStub.ts"

/** Scheduled-job handlers for the `schedule` group: list/cancel a session's approved scheduled jobs on its `Agent` DO; summaries carry retry/chain/triggered metadata. */
export const ScheduleHandlers = HttpApiBuilder.group(AgentApi, "schedule", (handlers) =>
  handlers
    .handle("listScheduledJobs", ({ params }) =>
      Effect.gen(function* () {
        const agents = yield* AgentStub
        const agent = agents.getByName(`${params.name}/${params.id}`)
        const jobs = yield* Effect.promise(() => agent.listScheduledJobs())
        return new ScheduledJobListResponse({
          jobs: jobs.map(
            (job) =>
              new ScheduledJobSummary({
                id: job.id,
                description: job.description,
                entrypointCommand: job.entrypointCommand,
                schedule: job.schedule,
                nextRunAt: job.nextRunAt,
                approvedAt: job.approvedAt,
                paused: job.paused,
                ...(job.lastRunStatus !== undefined ? { lastRunStatus: job.lastRunStatus } : {}),
                ...(job.notify !== undefined ? { notify: job.notify } : {}),
                ...(job.retry !== undefined ? { retry: job.retry } : {}),
                ...(job.chain !== undefined ? { chain: job.chain } : {}),
                ...(job.triggered ? { triggered: true } : {}),
              }),
          ),
        })
      }),
    )
    .handle("deleteScheduledJob", ({ params }) =>
      Effect.gen(function* () {
        const agents = yield* AgentStub
        const agent = agents.getByName(`${params.name}/${params.id}`)
        yield* Effect.promise(() => agent.deleteScheduledJob({ id: params.jobId }))
      }),
    )
    .handle("listRuns", ({ params }) =>
      Effect.gen(function* () {
        const agents = yield* AgentStub
        const agent = agents.getByName(`${params.name}/${params.id}`)
        const runs = yield* Effect.promise(() => agent.listRuns(params.jobId))
        return new ScheduledJobRunListResponse({
          runs: runs.map((run) => new ScheduledJobRunDetail(run)),
        })
      }),
    )
    .handle("pauseScheduledJob", ({ params }) =>
      Effect.gen(function* () {
        const agents = yield* AgentStub
        const agent = agents.getByName(`${params.name}/${params.id}`)
        yield* Effect.promise(() => agent.pauseScheduledJob({ id: params.jobId }))
      }),
    )
    .handle("resumeScheduledJob", ({ params }) =>
      Effect.gen(function* () {
        const agents = yield* AgentStub
        const agent = agents.getByName(`${params.name}/${params.id}`)
        yield* Effect.promise(() => agent.resumeScheduledJob({ id: params.jobId }))
      }),
    )
    .handle("runScheduledJobNow", ({ params }) =>
      Effect.gen(function* () {
        const agents = yield* AgentStub
        const agent = agents.getByName(`${params.name}/${params.id}`)
        const run = yield* Effect.promise(() => agent.runScheduledJobNow({ id: params.jobId }))
        return new ScheduledJobRunResponse({
          run: run === undefined ? null : new ScheduledJobRunDetail(run),
        })
      }),
    ),
)
