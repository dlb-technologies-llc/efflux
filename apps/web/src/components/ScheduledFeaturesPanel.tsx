import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import type {
  ScheduledJobRunDetail,
  ScheduledJobRunListResponse,
  ScheduledJobRunResponse,
  ScheduledJobSummary,
} from "@efflux/shared"
import { Exit } from "effect"
import { Bell, CalendarClock, ChevronRight, Repeat, Workflow } from "lucide-react"
import * as React from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import {
  deleteScheduledJobFn,
  listRunsFn,
  pauseScheduledJobFn,
  resumeScheduledJobFn,
  runScheduledJobNowFn,
  scheduledJobsAtom,
} from "../atoms/schedule.ts"
import { failureMessage } from "../errors.ts"
import { currentSessionAtom, type SessionArgs } from "../session.ts"
import { AsyncBoundary } from "./AsyncBoundary.tsx"
import { Spinner } from "./Spinner.tsx"

/** The stdout / stderr `<pre>` blocks for one captured run (or a "(no output captured)" note when both are empty). Shared by `RunDetailView` and `RunHistoryRow`. */
function RunOutput({ run }: { readonly run: ScheduledJobRunDetail }): React.ReactNode {
  return (
    <>
      {run.stdoutExcerpt.length > 0 ? (
        <div>
          <div className="text-muted-foreground">stdout</div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words">{run.stdoutExcerpt}</pre>
        </div>
      ) : null}
      {run.stderrExcerpt.length > 0 ? (
        <div>
          <div className="text-muted-foreground">stderr</div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-destructive">
            {run.stderrExcerpt}
          </pre>
        </div>
      ) : null}
      {run.stdoutExcerpt.length === 0 && run.stderrExcerpt.length === 0 ? (
        <p className="text-muted-foreground">(no output captured)</p>
      ) : null}
    </>
  )
}

/** Presentational render of one captured run (stdout / stderr / exit code), or a "hasn't run yet" note when `run` is null. Used by the inline "Run now" result so it renders output identically to the history rows. */
function RunDetailView({ run }: { readonly run: ScheduledJobRunDetail | null }): React.ReactNode {
  if (run === null) {
    return <p className="px-1 text-xs text-muted-foreground">Hasn't run yet.</p>
  }
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-bg-subtle p-2 font-mono text-xs">
      <div className="flex flex-wrap gap-3 text-muted-foreground">
        <span>Started: {new Date(run.startedAt).toLocaleString()}</span>
        <span>Exit code: {run.exitCode}</span>
      </div>
      <RunOutput run={run} />
    </div>
  )
}

/** One run in the history list: a click-to-expand summary row (started time, exit code, a pass/fail dot derived from `exitCode === 0`) that reveals the run's captured stdout/stderr on expand. Built on the shared `Collapsible` primitive for its disclosure semantics (aria-expanded, keyboard). */
function RunHistoryRow({ run }: { readonly run: ScheduledJobRunDetail }) {
  const [open, setOpen] = React.useState(false)
  const ok = run.exitCode === 0
  return (
    <li>
      <Collapsible open={open} onOpenChange={setOpen} className="rounded-md border border-border">
        <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <ChevronRight
            className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open ? "rotate-90" : "")}
          />
          <span className={cn("size-2 shrink-0 rounded-full", ok ? "bg-accent" : "bg-destructive")} />
          <span className="text-foreground">{new Date(run.startedAt).toLocaleString()}</span>
          <span className="text-muted-foreground">exit {run.exitCode}</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="px-2 pb-2 font-mono text-xs">
            <RunOutput run={run} />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}

/**
 * The expanded "view run history" body for one job: fetches lazily on first
 * expand via `listRunsFn`, then renders every captured run as a collapsed,
 * click-to-expand row (newest first) — a run's actual output is otherwise
 * generated and immediately discarded, visible nowhere else.
 */
function RunHistoryDetail({ session, jobId }: { readonly session: SessionArgs; readonly jobId: string }) {
  const runFetch = useAtomSet(listRunsFn, { mode: "promiseExit" })
  const [state, setState] = React.useState<
    | { readonly _tag: "loading" }
    | { readonly _tag: "error"; readonly message: string }
    | { readonly _tag: "loaded"; readonly response: ScheduledJobRunListResponse }
  >({ _tag: "loading" })

  React.useEffect(() => {
    let cancelled = false
    setState({ _tag: "loading" })
    void runFetch({ ...session, jobId }).then((exit) => {
      if (cancelled) return
      Exit.match(exit, {
        onFailure: (cause) => setState({ _tag: "error", message: failureMessage(cause, "Failed to load run history") }),
        onSuccess: (response) => setState({ _tag: "loaded", response }),
      })
    })
    return () => {
      cancelled = true
    }
  }, [runFetch, session, jobId])

  if (state._tag === "loading") {
    return (
      <div className="px-1">
        <Spinner label="Loading run history" />
      </div>
    )
  }
  if (state._tag === "error") {
    return <p className="px-1 text-xs text-destructive">{state.message}</p>
  }
  return state.response.runs.length === 0 ? (
    <p className="px-1 text-xs text-muted-foreground">No runs to show.</p>
  ) : (
    <ul className="flex max-h-80 flex-col gap-1 overflow-auto px-1">
      {state.response.runs.map((run, index) => (
        <RunHistoryRow key={`${run.startedAt}-${index}`} run={run} />
      ))}
    </ul>
  )
}

interface ScheduledJobRowProps {
  readonly session: SessionArgs
  readonly job: ScheduledJobSummary
  readonly onChanged: () => void
}

/**
 * One scheduled job row: description, formatted next-run time (or a "Paused"
 * indicator while paused), optional last-run status, a pause/resume button that
 * toggles the job via `pauseScheduledJobFn`/`resumeScheduledJobFn`, and a delete
 * button that cancels the job via `deleteScheduledJobFn`. All three refresh the
 * parent list (`onChanged`) on success — mirrors `SkillEditor`'s
 * delete-then-refresh shape in `SkillsPanel.tsx`. The meta line also surfaces
 * the DO-formatted `retry`/`chain` labels as outline badges, and a chain-only
 * (`triggered`) job swaps its schedule/next-run text for a "Runs when
 * triggered" chip — its sentinel `nextRunAt` of 0 must never render as a date.
 */
function ScheduledJobRow({ session, job, onChanged }: ScheduledJobRowProps) {
  const runDelete = useAtomSet(deleteScheduledJobFn, { mode: "promiseExit" })
  const runPause = useAtomSet(pauseScheduledJobFn, { mode: "promiseExit" })
  const runResume = useAtomSet(resumeScheduledJobFn, { mode: "promiseExit" })
  const runRunNow = useAtomSet(runScheduledJobNowFn, { mode: "promiseExit" })
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [expanded, setExpanded] = React.useState(false)
  const [running, setRunning] = React.useState(false)
  const [runNowResult, setRunNowResult] = React.useState<ScheduledJobRunResponse | null>(null)

  const handleRunNow = async () => {
    setRunning(true)
    setError(null)
    setRunNowResult(null)
    const exit = await runRunNow({ ...session, jobId: job.id })
    setRunning(false)
    Exit.match(exit, {
      onFailure: (cause) => {
        setError(failureMessage(cause, "Run request failed — the job may still have run; check its Last run status."))
        onChanged()
      },
      onSuccess: (response) => {
        if (response.run === null) {
          setError("Job could not be run (it is already running, or was removed).")
        } else {
          setExpanded(false)
          setRunNowResult(response)
        }
        onChanged()
      },
    })
  }

  const handleDelete = async () => {
    setBusy(true)
    setError(null)
    const exit = await runDelete({ ...session, jobId: job.id })
    setBusy(false)
    Exit.match(exit, {
      onFailure: (cause) => setError(failureMessage(cause, "Delete failed")),
      onSuccess: () => onChanged(),
    })
  }

  const handleTogglePause = async () => {
    setBusy(true)
    setError(null)
    const exit = job.paused
      ? await runResume({ ...session, jobId: job.id })
      : await runPause({ ...session, jobId: job.id })
    setBusy(false)
    Exit.match(exit, {
      onFailure: (cause) => setError(failureMessage(cause, job.paused ? "Resume failed" : "Pause failed")),
      onSuccess: () => onChanged(),
    })
  }

  return (
    <li className="flex flex-col gap-1 rounded-md border border-border px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-foreground">{job.description}</span>
        <div className="flex items-center gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={handleRunNow} disabled={busy || running}>
            {running ? "Running..." : "Run now"}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={handleTogglePause} disabled={busy || running}>
            {busy ? "Working..." : job.paused ? "Resume" : "Pause"}
          </Button>
          <Button type="button" variant="destructive" size="sm" onClick={handleDelete} disabled={busy || running}>
            {busy ? "Working..." : "Delete"}
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 font-mono text-xs text-muted-foreground">
        {job.triggered === true ? (
          <>
            {job.paused ? <span className="rounded bg-bg-subtle px-1.5 py-0.5 text-foreground">Paused</span> : null}
            <span className="rounded bg-bg-subtle px-1.5 py-0.5 text-foreground">Runs when triggered</span>
          </>
        ) : (
          <>
            <span>
              Schedule: <span className="text-foreground">{job.schedule}</span> UTC
            </span>
            {job.paused ? (
              <span className="rounded bg-bg-subtle px-1.5 py-0.5 text-foreground">Paused</span>
            ) : (
              <span>Next run: {new Date(job.nextRunAt).toLocaleString(undefined, { timeZone: "UTC", timeZoneName: "short" })}</span>
            )}
          </>
        )}
        {job.lastRunStatus !== undefined ? <span>Last run: {job.lastRunStatus}</span> : null}
        {job.notify !== undefined ? (
          <Badge variant="outline" className="font-mono font-normal text-muted-foreground">
            <Bell />
            {job.notify}
          </Badge>
        ) : null}
        {job.retry !== undefined ? (
          <Badge variant="outline" className="font-mono font-normal text-muted-foreground">
            <Repeat />
            {job.retry}
          </Badge>
        ) : null}
        {job.chain !== undefined ? (
          <Badge variant="outline" className="font-mono font-normal text-muted-foreground">
            <Workflow />
            {job.chain}
          </Badge>
        ) : null}
        {job.lastRunStatus !== undefined ? (
          <button
            type="button"
            className="text-accent underline-offset-2 hover:underline"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? "Hide run history" : "View run history"}
          </button>
        ) : null}
      </div>
      {expanded ? <RunHistoryDetail session={session} jobId={job.id} /> : null}
      {running ? (
        <div className="px-1">
          <Spinner label="Running job" />
        </div>
      ) : !expanded && runNowResult !== null && runNowResult.run !== null ? (
        <div className="flex flex-col gap-1">
          <span className="px-1 text-xs text-muted-foreground">Run now output</span>
          <RunDetailView run={runNowResult.run} />
        </div>
      ) : null}
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
                <ScheduledJobRow key={job.id} session={session} job={job} onChanged={refreshList} />
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
