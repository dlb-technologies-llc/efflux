import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { Exit, Schema } from "effect"
import * as React from "react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { approveStreamAtom, historyAtom } from "../atoms.ts"
import { type PendingApproval, pendingApprovals } from "../atoms/journal.ts"
import { putSecretFn } from "../atoms/secrets.ts"
import { setToolRuleFn, sessionConfigAtom } from "../atoms/tools.ts"
import { failureMessage } from "../errors.ts"
import { prettyParams } from "../format.ts"
import { currentSessionAtom, journalVersionAtom, type SessionArgs } from "../session.ts"
import { useJournal } from "../useJournal.ts"
import { AsyncBoundary } from "./AsyncBoundary.tsx"
import { StatusPill } from "./StatusPill.tsx"

interface ApprovalCardProps {
  readonly session: SessionArgs
  readonly approval: PendingApproval
}

/** True when a parked tool call carried params worth showing — anything but `undefined` or an empty params object (e.g. `list_skills`, which takes none). Shared by `CommandWell` and the approve-dialog copy so the "parameters below" wording never appears without a params well. */
const hasVisibleParams = (params: unknown): boolean =>
  params !== undefined &&
  !(typeof params === "object" && params !== null && Object.keys(params).length === 0)

/** The parked tool call's params in the shared mono well; renders nothing when the tool call carried no visible params, so a paramless tool never shows a bare `{}`. */
function CommandWell({ params }: { params: unknown }) {
  if (!hasVisibleParams(params)) return null
  return (
    <pre className="font-mono text-sm bg-bg-subtle border border-border rounded px-3 py-2 overflow-x-auto">
      {prettyParams(params)}
    </pre>
  )
}

/** `request_secret` tool params, decoded defensively — `toolParams` arrives as `unknown` off the journal. */
const RequestSecretParams = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
})
const isRequestSecretParams = Schema.is(RequestSecretParams)

/**
 * One parked approval, rendered as its own component so every hook (`busy` /
 * `error` state, the approve-stream setter, the version bump, the history
 * refresh) lives at a stable top level — the parent never calls a hook inside
 * its `.map`. Deciding DRAINS the continuation SSE (the server loop is
 * pull-driven, so the `await` is load-bearing); on success it bumps the journal
 * version (the timeline and this list refetch, unmounting the card) and
 * refreshes history. Approve is gated behind an `AlertDialog` echoing the exact
 * command; Deny rejects in one step.
 */
function ApprovalCard({ approval, session }: ApprovalCardProps) {
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [secretValue, setSecretValue] = React.useState("")
  const run = useAtomSet(approveStreamAtom, { mode: "promiseExit" })
  const runPutSecret = useAtomSet(putSecretFn, { mode: "promiseExit" })
  const bump = useAtomSet(journalVersionAtom)
  const refreshHistory = useAtomRefresh(historyAtom(session))
  const runSetRule = useAtomSet(setToolRuleFn, { mode: "promiseExit" })
  const refreshConfig = useAtomRefresh(sessionConfigAtom(session))

  const decide = async (approved: boolean): Promise<boolean> => {
    setBusy(true)
    setError(null)
    const exit = await run({ ...session, eventId: approval.eventId, approved })
    return Exit.match(exit, {
      onFailure: (cause) => {
        setError(failureMessage(cause, "Approval failed"))
        setBusy(false)
        return false
      },
      onSuccess: () => {
        bump((v) => v + 1)
        refreshHistory()
        setBusy(false)
        return true
      },
    })
  }

  const allowAlways = async () => {
    const name = approval.toolName
    if (name === undefined) return
    setBusy(true)
    setError(null)
    const exit = await runSetRule({ ...session, tool: name, rule: "allow" })
    if (Exit.isFailure(exit)) {
      setError(failureMessage(exit.cause, "Could not update approval rule"))
      setBusy(false)
      return
    }
    refreshConfig()
    const approved = await decide(true)
    if (!approved) {
      setError(`Set ${name} to always allow this session, but approving this call failed — retry Approve.`)
    }
  }

  const toolName = approval.toolName ?? "tool call"
  const secretParams = toolName === "request_secret" && isRequestSecretParams(approval.toolParams)
    ? approval.toolParams
    : null

  const submitSecret = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (secretParams === null) return
    setBusy(true)
    setError(null)
    const exit = await runPutSecret({ ...session, key: secretParams.name, value: secretValue })
    if (Exit.isFailure(exit)) {
      setError(failureMessage(exit.cause, "Failed to store secret"))
      setBusy(false)
      return
    }
    await decide(true)
  }

  return (
    <Card className="gap-3 py-4 border-l-[3px] border-l-warning bg-warning/5">
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill state="warning" dot label="awaiting approval" />
          <span className="font-mono text-sm font-semibold">{toolName}</span>
          <span className="ml-auto font-mono text-xs text-muted-foreground">
            turn {approval.turn} · hop {approval.hop}
          </span>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {secretParams !== null ? null : <CommandWell params={approval.toolParams} />}
        {error !== null ? (
          <p role="alert" className="m-0 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {secretParams !== null ? (
          <form className="flex flex-col gap-3" onSubmit={submitSecret}>
            <p className="m-0 text-sm text-muted-foreground">{secretParams.description}</p>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`secret-value-${approval.eventId}`}>{secretParams.name}</Label>
              <Input
                id={`secret-value-${approval.eventId}`}
                type="password"
                autoComplete="off"
                value={secretValue}
                onChange={(event) => setSecretValue(event.target.value)}
                disabled={busy}
                required
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" disabled={busy || secretValue.length === 0}>
                Submit
              </Button>
              <Button type="button" variant="destructive" disabled={busy} onClick={() => decide(false)}>
                Skip
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button type="button" disabled={busy}>
                  Approve
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Approve {toolName}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Confirm to run this {toolName} call{hasVisibleParams(approval.toolParams) ? " with the parameters below" : ""}.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <CommandWell params={approval.toolParams} />
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => decide(true)}>Approve</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            {approval.toolName !== undefined ? (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button type="button" variant="outline" disabled={busy}>
                    Always allow
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Always allow {toolName} this session?</AlertDialogTitle>
                    <AlertDialogDescription>
                      {toolName} will run for the rest of this session without asking again. Confirm to approve this
                      call and stop parking future ones.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={allowAlways}>Always allow</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : null}
            <Button type="button" variant="destructive" disabled={busy} onClick={() => decide(false)}>
              Deny
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * Actionable cards for every parked tool call in the active session's journal.
 * Reads the paged journal, computes the still-pending approvals, and renders one
 * `<ApprovalCard>` per approval (each owns its own hooks — the parent runs none
 * inside the map, keeping hook counts stable across renders). A count `Badge`
 * surfaces when more than one approval is parked.
 */
export function ApprovalCards() {
  const session = useAtomValue(currentSessionAtom)
  const { result, refresh } = useJournal(session)

  return (
    <section className="flex flex-col gap-3 p-4 min-w-0">
      <h2 className="m-0 text-sm font-semibold tracking-wide">Approvals</h2>
      <AsyncBoundary
        result={result}
        onRetry={refresh}
        empty={<p className="m-0 text-sm text-muted-foreground">No pending approvals.</p>}
      >
        {(events) => {
          const pending = pendingApprovals(events)
          if (pending.length === 0) {
            return <p className="m-0 text-sm text-muted-foreground">No pending approvals.</p>
          }
          return (
            <div className="flex flex-col gap-3">
              {pending.length > 1 ? (
                <Badge variant="secondary" className="w-fit font-mono">
                  {pending.length} pending
                </Badge>
              ) : null}
              {pending.map((approval) => (
                <ApprovalCard key={approval.eventId} session={session} approval={approval} />
              ))}
            </div>
          )
        }}
      </AsyncBoundary>
    </section>
  )
}
