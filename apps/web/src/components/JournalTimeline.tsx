import { useAtomValue } from "@effect/atom-react"
import type { JournalEvent } from "@effect-flue/shared"
import { AsyncResult } from "effect/unstable/reactivity"
import type * as React from "react"
import { failureMessage } from "../errors.ts"
import { formatParams, formatTokens, formatUsd } from "../format.ts"
import { currentSessionAtom } from "../session.ts"
import { useJournal } from "../useJournal.ts"
import styles from "./JournalTimeline.module.css"

/** One turn's events grouped under the `user-message` whose envelope `seq` equals `turn` (the turn header); `events` holds every other envelope carrying `event.turn === turn`, in seq order. */
interface TurnGroup {
  readonly turn: number
  header: JournalEvent | undefined
  readonly events: Array<JournalEvent>
}

/** Fold the flat event list into ordered turns per the journal's turn convention: a `user-message` at `seq=N` opens turn N; every other event joins the turn named by `event.turn`. */
const groupByTurn = (events: ReadonlyArray<JournalEvent>): ReadonlyArray<TurnGroup> => {
  const byTurn = new Map<number, TurnGroup>()
  const ensure = (turn: number): TurnGroup => {
    const existing = byTurn.get(turn)
    if (existing !== undefined) return existing
    const created: TurnGroup = { turn, header: undefined, events: [] }
    byTurn.set(turn, created)
    return created
  }
  for (const envelope of events) {
    if (envelope.event._tag === "user-message") ensure(envelope.seq).header = envelope
    else if (envelope.event._tag !== "hop-messages") ensure(envelope.event.turn).events.push(envelope)
  }
  return Array.from(byTurn.values()).sort((a, b) => a.turn - b.turn)
}

/** Sum a turn's `usage` events into total tokens and USD cost; `hasUsage` gates whether the footer renders. */
const turnTotals = (events: ReadonlyArray<JournalEvent>): { tokens: number; cost: number; hasUsage: boolean } => {
  let tokens = 0
  let cost = 0
  let hasUsage = false
  for (const envelope of events) {
    const event = envelope.event
    if (event._tag !== "usage") continue
    hasUsage = true
    tokens += event.totalTokens ?? (event.inputTokens ?? 0) + (event.outputTokens ?? 0)
    cost += event.cost ?? 0
  }
  return { tokens, cost, hasUsage }
}

/** Render one journal envelope by its payload `_tag`; the union narrows through the `switch`, no casts. */
const renderEvent = (envelope: JournalEvent): React.ReactNode => {
  const event = envelope.event
  switch (event._tag) {
    case "user-message":
      return (
        <div className={styles.rowUser}>
          <span className={styles.label}>user</span>
          <div className={styles.content}>{event.content}</div>
          <div className={styles.chips}>
            {event.skill !== undefined ? <span className={styles.chip}>skill: {event.skill}</span> : null}
            {event.role !== undefined ? <span className={styles.chip}>role: {event.role}</span> : null}
            {event.model !== undefined ? <span className={styles.chip}>model: {event.model}</span> : null}
          </div>
        </div>
      )
    case "assistant-text":
      return (
        <div className={styles.rowAssistant}>
          <span className={styles.label}>assistant</span>
          <div className={styles.content}>{event.text}</div>
        </div>
      )
    case "tool-call":
      return (
        <div className={styles.rowTool}>
          <span className={styles.label}>tool call</span>
          <span className={styles.toolName}>{event.part.name}</span>
          <div className={styles.scroll}>
            <code className={styles.params}>{formatParams(event.part.params)}</code>
          </div>
        </div>
      )
    case "tool-result":
      return (
        <div className={event.part.isFailure ? styles.rowResultFail : styles.rowResultOk}>
          <span className={styles.mark}>{event.part.isFailure ? "✗" : "✓"}</span>
          <span className={styles.toolName}>{event.part.name}</span>
        </div>
      )
    case "usage": {
      const tokens = event.totalTokens ?? (event.inputTokens ?? 0) + (event.outputTokens ?? 0)
      return (
        <div className={styles.rowUsage}>
          <span className={styles.label}>usage</span>
          <span className={styles.usageValue}>{formatTokens(tokens)} tok</span>
          {event.cost !== undefined ? <span className={styles.usageValue}>{formatUsd(event.cost)}</span> : null}
          <span className={styles.usageModel}>{event.model}</span>
        </div>
      )
    }
    case "approval-requested":
      return <span className={styles.chipApproval}>approval requested</span>
    case "approval-resolved":
      return (
        <span className={event.approved ? styles.chipApproved : styles.chipDenied}>
          {event.approved ? "approved" : "denied"}
          {event.reason !== undefined ? `: ${event.reason}` : ""}
        </span>
      )
    case "done":
      return <div className={styles.rowDone}>done — {event.finishReason}</div>
    case "error":
      return <div className={styles.rowError}>error: {event.message}</div>
    case "hop-messages":
      return null
  }
}

/**
 * Per-session event timeline. Groups the journal by turn, renders every event
 * by its `_tag`, and closes each turn with a token/cost footer summed from its
 * `usage` events. Refetches whenever `journalVersionAtom` bumps (a turn or an
 * approval elsewhere mutated the journal) or the active session changes.
 */
export function JournalTimeline() {
  const session = useAtomValue(currentSessionAtom)
  const { result: journalResult, refresh } = useJournal(session)

  return (
    <section className={styles.timeline}>
      <header className={styles.header}>
        <h2 className={styles.title}>Journal</h2>
        <button type="button" className={styles.refresh} onClick={() => refresh()}>
          Refresh
        </button>
      </header>
      {AsyncResult.match(journalResult, {
        onInitial: () => <p className={styles.pending}>Loading journal...</p>,
        onFailure: (failure) => (
          <p className={styles.error}>
            Failed to load journal: {failureMessage(failure.cause, "Something went wrong")}
          </p>
        ),
        onSuccess: (success) => {
          const turns = groupByTurn(success.value)
          if (turns.length === 0) return <p className={styles.pending}>No events yet.</p>
          return (
            <ol className={styles.turns}>
              {turns.map((turn) => {
                const totals = turnTotals(turn.events)
                return (
                  <li key={turn.turn} className={styles.turn}>
                    <div className={styles.turnLabel}>turn {turn.turn}</div>
                    {turn.header !== undefined ? (
                      <div className={styles.row}>{renderEvent(turn.header)}</div>
                    ) : null}
                    {turn.events.map((envelope) => (
                      <div key={envelope.seq} className={styles.row}>
                        {renderEvent(envelope)}
                      </div>
                    ))}
                    {totals.hasUsage ? (
                      <div className={styles.turnFooter}>
                        <span>{formatTokens(totals.tokens)} tokens</span>
                        <span>{formatUsd(totals.cost)}</span>
                      </div>
                    ) : null}
                  </li>
                )
              })}
            </ol>
          )
        },
      })}
    </section>
  )
}
