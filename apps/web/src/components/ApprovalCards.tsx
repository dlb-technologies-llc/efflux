import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { Exit } from "effect"
import { AsyncResult } from "effect/unstable/reactivity"
import * as React from "react"
import { approveStreamAtom, historyAtom } from "../atoms.ts"
import { type PendingApproval, pendingApprovals } from "../atoms/journal.ts"
import { failureMessage } from "../errors.ts"
import { formatParams } from "../format.ts"
import { currentSessionAtom, journalVersionAtom, type SessionArgs } from "../session.ts"
import { useJournal } from "../useJournal.ts"
import styles from "./ApprovalCards.module.css"

interface ApprovalCardProps {
  readonly session: SessionArgs
  readonly approval: PendingApproval
}

/**
 * One parked approval, rendered as its own component so every hook (`busy` /
 * `error` / deny-`reason` state, the approve-stream setter, the version bump,
 * the history refresh) lives at a stable top level — the parent never calls a
 * hook inside its `.map`. Deciding DRAINS the continuation SSE (the server loop
 * is pull-driven, so the `await` is load-bearing); on success it bumps the
 * journal version (the timeline and this list refetch, unmounting the card) and
 * refreshes history.
 */
function ApprovalCard({ approval, session }: ApprovalCardProps) {
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [denying, setDenying] = React.useState(false)
  const [reason, setReason] = React.useState("")
  const run = useAtomSet(approveStreamAtom, { mode: "promiseExit" })
  const bump = useAtomSet(journalVersionAtom)
  const refreshHistory = useAtomRefresh(historyAtom(session))

  const decide = async (approved: boolean) => {
    setBusy(true)
    setError(null)
    const trimmed = reason.trim()
    const exit = await run({
      ...session,
      eventId: approval.eventId,
      approved,
      ...(approved === false && trimmed.length > 0 ? { reason: trimmed } : {}),
    })
    Exit.match(exit, {
      onFailure: (cause) => {
        setError(failureMessage(cause, "Approval failed"))
        setBusy(false)
      },
      onSuccess: () => {
        bump((v) => v + 1)
        refreshHistory()
        setBusy(false)
      },
    })
  }

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <span className={styles.toolName}>{approval.toolName ?? "tool call"}</span>
        <span className={styles.badge}>turn {approval.turn} · hop {approval.hop}</span>
      </div>
      {approval.toolParams !== undefined ? (
        <div className={styles.scroll}>
          <code className={styles.params}>{formatParams(approval.toolParams)}</code>
        </div>
      ) : null}
      {error !== null ? <p className={styles.error}>{error}</p> : null}
      <div className={styles.actions}>
        <button type="button" className={styles.approve} disabled={busy} onClick={() => decide(true)}>
          {busy ? <span className={styles.spinner} aria-hidden /> : null}Approve
        </button>
        {denying ? (
          <div className={styles.denyRow}>
            <input
              type="text"
              className={styles.reasonInput}
              placeholder="Reason (optional)"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              disabled={busy}
            />
            <button type="button" className={styles.deny} disabled={busy} onClick={() => decide(false)}>
              Confirm deny
            </button>
          </div>
        ) : (
          <button type="button" className={styles.denyToggle} disabled={busy} onClick={() => setDenying(true)}>
            Deny
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * Actionable cards for every parked tool call in the active session's journal.
 * Reads the paged journal, computes the still-pending approvals, and renders one
 * `<ApprovalCard>` per approval (each owns its own hooks — the parent runs none
 * inside the map, keeping hook counts stable across renders).
 */
export function ApprovalCards() {
  const session = useAtomValue(currentSessionAtom)
  const { result: journalResult } = useJournal(session)

  return (
    <section className={styles.panel}>
      <h2 className={styles.title}>Approvals</h2>
      {AsyncResult.match(journalResult, {
        onInitial: () => <p className={styles.pending}>Loading approvals...</p>,
        onFailure: (failure) => (
          <p className={styles.error}>
            Failed to load approvals: {failureMessage(failure.cause, "Something went wrong")}
          </p>
        ),
        onSuccess: (success) => {
          const pending = pendingApprovals(success.value)
          if (pending.length === 0) return <p className={styles.empty}>No pending approvals.</p>
          return (
            <div className={styles.cards}>
              {pending.map((approval) => (
                <ApprovalCard key={approval.eventId} session={session} approval={approval} />
              ))}
            </div>
          )
        },
      })}
    </section>
  )
}
