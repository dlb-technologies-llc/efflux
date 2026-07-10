import { useAtomValue } from "@effect/atom-react"
import type { JournalEvent, JournalToolResult } from "@efflux/shared"
import type * as React from "react"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import { toolCallResults } from "../atoms/journal.ts"
import { formatTokens, formatUsd } from "../format.ts"
import { currentSessionAtom } from "../session.ts"
import { useJournal } from "../useJournal.ts"
import { AsyncBoundary } from "./AsyncBoundary.tsx"
import { Markdown } from "./Markdown.tsx"
import { StatusPill } from "./StatusPill.tsx"
import { ToolCallCard } from "./ToolCallCard.tsx"

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
    else if (
      envelope.event._tag !== "hop-messages" &&
      envelope.event._tag !== "session-closed" &&
      envelope.event._tag !== "compaction"
    )
      ensure(envelope.event.turn).events.push(envelope)
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

/** The rail-node accent for one timeline row, keyed to the event's semantic kind. */
type NodeTone = "accent" | "success" | "danger" | "warning" | "muted"

/** Tailwind background for a rail dot of each {@link NodeTone}. */
const dotToneClass: Record<NodeTone, string> = {
  accent: "bg-primary",
  success: "bg-success",
  danger: "bg-destructive",
  warning: "bg-warning",
  muted: "bg-muted-foreground",
}

/** StatusPill state and label per todo status; the `??` fallback degrades an unknown status to a neutral pill of its raw name. */
const todoPill: Record<string, { state: "neutral" | "accent" | "success"; label: string }> = {
  pending: { state: "neutral", label: "pending" },
  in_progress: { state: "accent", label: "in progress" },
  completed: { state: "success", label: "done" },
}

/**
 * Render one journal envelope as a rail row `{ tone, node }`, or `null` when the
 * event is folded into another surface (`tool-result` shows inside its call card)
 * or is never displayed (`hop-messages`, `compaction`, `session-closed`). The
 * `switch` stays total over `JournalEventPayload` — narrowing through `_tag`, no
 * casts. `resultByCallId` pairs each `tool-call` with its journalled result so a
 * call and its outcome render as one {@link ToolCallCard}.
 */
const renderEvent = (
  envelope: JournalEvent,
  resultByCallId: ReadonlyMap<string, JournalToolResult>,
): { tone: NodeTone; node: React.ReactNode } | null => {
  const event = envelope.event
  switch (event._tag) {
    case "user-message":
      return {
        tone: "accent",
        node: (
          <div className="grid gap-1.5 min-w-0">
            <span className="text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              user
            </span>
            <div className="whitespace-pre-wrap break-words text-sm text-foreground">{event.content}</div>
            {event.skill !== undefined || event.role !== undefined || event.model !== undefined ? (
              <div className="flex flex-wrap gap-1.5">
                {event.skill !== undefined ? <StatusPill state="neutral" label={`skill: ${event.skill}`} /> : null}
                {event.role !== undefined ? <StatusPill state="neutral" label={`role: ${event.role}`} /> : null}
                {event.model !== undefined ? <StatusPill state="neutral" label={event.model} /> : null}
              </div>
            ) : null}
          </div>
        ),
      }
    case "assistant-text":
      return { tone: "accent", node: <Markdown content={event.text} /> }
    case "tool-call": {
      const result = resultByCallId.get(event.part.id)
      const tone: NodeTone = result === undefined ? "accent" : result.part.isFailure ? "danger" : "success"
      return {
        tone,
        node: (
          <ToolCallCard
            call={{
              name: event.part.name,
              params: event.part.params,
              ...(result !== undefined
                ? { result: result.part.result, isFailure: result.part.isFailure }
                : { running: true }),
            }}
          />
        ),
      }
    }
    case "tool-result":
      return null
    case "usage": {
      const tokens = event.totalTokens ?? (event.inputTokens ?? 0) + (event.outputTokens ?? 0)
      return {
        tone: "muted",
        node: (
          <div className="flex items-center gap-2 font-mono text-xs tabular-nums text-muted-foreground">
            <span>{formatTokens(tokens)} tok</span>
            {event.cost !== undefined ? <span>{formatUsd(event.cost)}</span> : null}
            <span className="ml-auto truncate">{event.model}</span>
          </div>
        ),
      }
    }
    case "approval-requested":
      return { tone: "warning", node: <StatusPill state="warning" label="approval requested" /> }
    case "approval-resolved":
      return {
        tone: event.approved ? "success" : "danger",
        node: (
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill state={event.approved ? "success" : "danger"} label={event.approved ? "approved" : "denied"} />
            {!event.approved && event.reason !== undefined ? (
              <span className="text-xs text-muted-foreground">{event.reason}</span>
            ) : null}
          </div>
        ),
      }
    case "done":
      return { tone: "success", node: <StatusPill state="success" label={`done · ${event.finishReason}`} /> }
    case "error":
      return {
        tone: "danger",
        node: (
          <div className="flex flex-wrap items-start gap-2">
            <StatusPill state="danger" label="error" />
            <span className="break-words text-xs text-destructive">{event.message}</span>
          </div>
        ),
      }
    case "todo-write":
      return {
        tone: "muted",
        node: (
          <div className="grid gap-1.5">
            <span className="text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              todo
            </span>
            <ul className="grid gap-1">
              {event.items.map((item, index) => {
                const pill = todoPill[item.status] ?? { state: "neutral", label: item.status }
                return (
                  <li key={index} className="flex items-start gap-2 text-sm">
                    <StatusPill state={pill.state} label={pill.label} />
                    <span className="whitespace-pre-wrap break-words">{item.content}</span>
                  </li>
                )
              })}
            </ul>
          </div>
        ),
      }
    case "hop-messages":
      return null
    case "compaction":
      return null
    case "session-closed":
      return null
  }
}

/** One node on a turn's vertical rail: a tone-colored dot pinned onto the rail, its event content to the right. */
function TimelineRow({ tone, children }: { tone: NodeTone; children: React.ReactNode }): React.ReactNode {
  return (
    <li className="relative min-w-0">
      <span
        aria-hidden="true"
        className={cn("absolute -left-6 top-1.5 size-2 rounded-full ring-2 ring-surface-2", dotToneClass[tone])}
      />
      <div className="min-w-0">{children}</div>
    </li>
  )
}

/** A between-turns marker that a context compaction folded history through `throughSeq`; a `Separator` pair replaces the former glyph. */
function CompactionDivider({ throughSeq }: { throughSeq: number }): React.ReactNode {
  return (
    <div className="flex items-center gap-3 py-1">
      <Separator className="flex-1" />
      <span className="whitespace-nowrap text-[0.7rem] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        context compacted through #{throughSeq}
      </span>
      <Separator className="flex-1" />
    </div>
  )
}

/**
 * Per-session event timeline. Groups the journal by turn, renders each turn as a
 * railed group — a tone-colored node per event, tool call and result paired into
 * one {@link ToolCallCard} — and closes each turn with a token/cost footer summed
 * from its `usage` events. `useJournal` refetches whenever `journalVersionAtom`
 * bumps (a turn or approval elsewhere mutated the journal) or the session changes.
 */
export function JournalTimeline() {
  const session = useAtomValue(currentSessionAtom)
  const { result: journalResult, refresh } = useJournal(session)

  return (
    <section className="flex min-w-0 flex-col gap-4 p-4 text-sm">
      <header className="sticky top-0 z-10 -mx-4 -mt-4 flex items-center justify-between gap-2 border-b border-border bg-background/80 px-4 py-3 backdrop-blur">
        <h2 className="text-sm font-semibold tracking-tight">Journal</h2>
        <Button variant="outline" size="sm" onClick={() => refresh()}>
          Refresh
        </Button>
      </header>
      <AsyncBoundary result={journalResult} onRetry={refresh}>
        {(events) => {
          const turns = groupByTurn(events)
          const items: Array<
            | { readonly kind: "turn"; readonly seq: number; readonly turn: TurnGroup }
            | { readonly kind: "compaction"; readonly seq: number; readonly throughSeq: number }
          > = []
          for (const turn of turns) {
            items.push({ kind: "turn", seq: turn.turn, turn })
          }
          for (const envelope of events) {
            if (envelope.event._tag === "compaction") {
              items.push({ kind: "compaction", seq: envelope.seq, throughSeq: envelope.event.throughSeq })
            }
          }
          items.sort((a, b) => a.seq - b.seq)
          if (items.length === 0) {
            return <p className="m-0 text-sm text-muted-foreground">No events yet.</p>
          }
          return (
            <div className="flex flex-col gap-4">
              {items.map((item) => {
                if (item.kind === "compaction") {
                  return <CompactionDivider key={`compaction-${item.seq}`} throughSeq={item.throughSeq} />
                }
                const turn = item.turn
                const totals = turnTotals(turn.events)
                const resultByCallId = new Map<string, JournalToolResult>()
                for (const pair of toolCallResults(turn.events)) {
                  if (pair.result !== undefined) resultByCallId.set(pair.call.part.id, pair.result)
                }
                const rows: Array<{ key: string; tone: NodeTone; node: React.ReactNode }> = []
                if (turn.header !== undefined) {
                  const rendered = renderEvent(turn.header, resultByCallId)
                  if (rendered !== null) rows.push({ key: `header-${turn.header.seq}`, ...rendered })
                }
                for (const envelope of turn.events) {
                  const rendered = renderEvent(envelope, resultByCallId)
                  if (rendered !== null) rows.push({ key: String(envelope.seq), ...rendered })
                }
                return (
                  <div key={`turn-${turn.turn}`} className="grid gap-3 rounded-lg border border-border bg-surface-2 p-4">
                    <div className="text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                      turn {turn.turn}
                    </div>
                    <ol className="relative ml-1 grid gap-3 border-l border-border pl-5">
                      {rows.map((row) => (
                        <TimelineRow key={row.key} tone={row.tone}>
                          {row.node}
                        </TimelineRow>
                      ))}
                    </ol>
                    {totals.hasUsage ? (
                      <div className="flex justify-end gap-3 border-t border-border pt-2 font-mono text-xs tabular-nums text-muted-foreground">
                        <span>{formatTokens(totals.tokens)} tok</span>
                        <span>{formatUsd(totals.cost)}</span>
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          )
        }}
      </AsyncBoundary>
    </section>
  )
}
