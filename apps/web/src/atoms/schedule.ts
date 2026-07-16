import { Effect } from "effect"
import { Atom } from "effect/unstable/reactivity"
import { ApiClient, runtime } from "../runtime.ts"
import type { SessionArgs } from "../session.ts"

/**
 * Query atom (per-session): every scheduled job for a session from
 * `GET /agents/:name/:id/schedule`. `Atom.family` memoises per `{name, id}`,
 * so the fetch fires on first subscribe and a later
 * `useAtomRefresh(scheduledJobsAtom(session))` re-runs the same atom.
 */
export const scheduledJobsAtom = Atom.family((args: SessionArgs) =>
  runtime.atom(
    Effect.fnUntraced(function*() {
      const client = yield* ApiClient
      return yield* client.schedule.listScheduledJobs({ params: { name: args.name, id: args.id } })
    })(),
  )
)

/** Mutation fn: cancel a scheduled job via `DELETE /agents/:name/:id/schedule/:jobId`. */
export const deleteScheduledJobFn = runtime.fn(
  (args: SessionArgs & { readonly jobId: string }) =>
    Effect.gen(function*() {
      const client = yield* ApiClient
      return yield* client.schedule.deleteScheduledJob({
        params: { name: args.name, id: args.id, jobId: args.jobId },
      })
    }),
)

/** Mutation fn: pause a scheduled job via `POST /agents/:name/:id/schedule/:jobId/pause`. Retains config; the job stops firing until resumed. */
export const pauseScheduledJobFn = runtime.fn(
  (args: SessionArgs & { readonly jobId: string }) =>
    Effect.gen(function*() {
      const client = yield* ApiClient
      return yield* client.schedule.pauseScheduledJob({
        params: { name: args.name, id: args.id, jobId: args.jobId },
      })
    }),
)

/** Mutation fn: resume a paused scheduled job via `POST /agents/:name/:id/schedule/:jobId/resume`. It fires again on the next upcoming slot of its existing schedule. */
export const resumeScheduledJobFn = runtime.fn(
  (args: SessionArgs & { readonly jobId: string }) =>
    Effect.gen(function*() {
      const client = yield* ApiClient
      return yield* client.schedule.resumeScheduledJob({
        params: { name: args.name, id: args.id, jobId: args.jobId },
      })
    }),
)

/**
 * On-demand fetch fn (not an auto-fetching atom): a job's full run history from
 * `GET /agents/:name/:id/schedule/:jobId/runs` — every run the DO still retains,
 * most recent first, each run's captured stdout/stderr. Fetched lazily per row
 * (on a "view run history" click), not an `Atom.family` that would fire N
 * requests just to render the job list.
 */
export const listRunsFn = runtime.fn(
  (args: SessionArgs & { readonly jobId: string }) =>
    Effect.gen(function*() {
      const client = yield* ApiClient
      return yield* client.schedule.listRuns({
        params: { name: args.name, id: args.id, jobId: args.jobId },
      })
    }),
)

/**
 * Mutation fn: fire a scheduled job immediately via
 * `POST /agents/:name/:id/schedule/:jobId/run-now`, independent of its schedule.
 * Resolves with the run's captured output (the same `ScheduledJobRunResponse`
 * shape as {@link listRunsFn}) once the run completes — the request is held
 * open for the full run, so a slow Runner cold-start keeps it pending rather
 * than failing.
 */
export const runScheduledJobNowFn = runtime.fn(
  (args: SessionArgs & { readonly jobId: string }) =>
    Effect.gen(function*() {
      const client = yield* ApiClient
      return yield* client.schedule.runScheduledJobNow({
        params: { name: args.name, id: args.id, jobId: args.jobId },
      })
    }),
)
