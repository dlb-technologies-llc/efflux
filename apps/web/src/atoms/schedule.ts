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
