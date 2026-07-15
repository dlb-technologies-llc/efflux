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
 * On-demand fetch fn (not an auto-fetching atom): a job's most recent run —
 * its actual captured stdout/stderr, otherwise generated and discarded with
 * no way to see it. Deliberately fetched lazily per row (on a "view last run"
 * click) rather than an `Atom.family` that would fire N requests just to
 * render an N-job list.
 */
export const getLastRunFn = runtime.fn(
  (args: SessionArgs & { readonly jobId: string }) =>
    Effect.gen(function*() {
      const client = yield* ApiClient
      return yield* client.schedule.getLastRun({
        params: { name: args.name, id: args.id, jobId: args.jobId },
      })
    }),
)
