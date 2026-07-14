import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import type { ScheduledJobSummary } from "@efflux/shared"
import { Exit } from "effect"
import { CalendarClock } from "lucide-react"
import * as React from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { deleteScheduledJobFn, scheduledJobsAtom } from "../atoms/schedule.ts"
import { failureMessage } from "../errors.ts"
import { currentSessionAtom, type SessionArgs } from "../session.ts"
import { AsyncBoundary } from "./AsyncBoundary.tsx"

interface ScheduledJobRowProps {
  readonly session: SessionArgs
  readonly job: ScheduledJobSummary
  readonly onDeleted: () => void
}

/**
 * One scheduled job row: description, formatted next-run time, optional last-run
 * status, and a delete button that cancels the job via `deleteScheduledJobFn` and
 * refreshes the parent list (`onDeleted`) on success — mirrors `SkillEditor`'s
 * delete-then-refresh shape in `SkillsPanel.tsx`.
 */
function ScheduledJobRow({ session, job, onDeleted }: ScheduledJobRowProps) {
  const runDelete = useAtomSet(deleteScheduledJobFn, { mode: "promiseExit" })
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const handleDelete = async () => {
    setBusy(true)
    setError(null)
    const exit = await runDelete({ ...session, jobId: job.id })
    setBusy(false)
    Exit.match(exit, {
      onFailure: (cause) => setError(failureMessage(cause, "Delete failed")),
      onSuccess: () => onDeleted(),
    })
  }

  return (
    <li className="flex flex-col gap-1 rounded-md border border-border px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-foreground">{job.description}</span>
        <Button type="button" variant="destructive" size="sm" onClick={handleDelete} disabled={busy}>
          {busy ? "Working..." : "Delete"}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 font-mono text-xs text-muted-foreground">
        <span>Next run: {new Date(job.nextRunAt).toLocaleString()}</span>
        {job.lastRunStatus !== undefined ? <span>Last run: {job.lastRunStatus}</span> : null}
      </div>
      {error !== null ? <p className="text-sm text-destructive">{error}</p> : null}
    </li>
  )
}

/**
 * Dialog body: a `ScrollArea` list of the current session's scheduled jobs.
 * Lives inside `DialogContent` so `scheduledJobsAtom` subscribes (and the list
 * fetches) only once the dialog opens. Refetches via `useAtomRefresh` after a
 * row's delete succeeds, mirroring `SkillsManager`'s refresh mechanism.
 */
function ScheduledFeaturesManager() {
  const session = useAtomValue(currentSessionAtom)
  const list = useAtomValue(scheduledJobsAtom(session))
  const refreshList = useAtomRefresh(scheduledJobsAtom(session))

  return (
    <ScrollArea className="min-h-0 flex-1 rounded-md border">
      <AsyncBoundary
        result={list}
        onRetry={refreshList}
        empty={<p className="p-3 text-sm text-muted-foreground">No scheduled features yet.</p>}
      >
        {(value) =>
          value.jobs.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">No scheduled features yet.</p>
          ) : (
            <ul className="flex flex-col gap-2 p-3">
              {value.jobs.map((job) => (
                <ScheduledJobRow key={job.id} session={session} job={job} onDeleted={refreshList} />
              ))}
            </ul>
          )}
      </AsyncBoundary>
    </ScrollArea>
  )
}

/**
 * Self-contained scheduled-features manager: renders its own trigger `Button`
 * and a `Dialog` holding the list. Propless — `App` drops it into the top bar
 * alongside `SkillsPanel` and it drives everything off the `/schedule` atoms
 * for the current session itself.
 */
export function ScheduledFeaturesPanel() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm">
          <CalendarClock />
          Scheduled
        </Button>
      </DialogTrigger>
      <DialogContent className="flex h-[80vh] flex-col gap-4 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Scheduled Features</DialogTitle>
          <DialogDescription>
            Jobs the agent has scheduled for the current session.
          </DialogDescription>
        </DialogHeader>
        <ScheduledFeaturesManager />
      </DialogContent>
    </Dialog>
  )
}
