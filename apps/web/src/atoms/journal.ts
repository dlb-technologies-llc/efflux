import { Effect } from "effect"
import { Atom } from "effect/unstable/reactivity"
import type { JournalEvent, JournalToolCall, JournalToolResult } from "@efflux/shared"
import { ApiClient, runtime } from "../runtime.ts"
import type { SessionArgs } from "../session.ts"

/**
 * Query atom (per-session): fully page the append-only journal into one ordered
 * `JournalEvent[]`. `Atom.family` memoises via structural `Equal`/`Hash`, so each
 * unique `{name, id}` returns the same atom and the fetch fires on first
 * subscribe; `JournalTimeline` refreshes it whenever `journalVersionAtom` bumps.
 */
export const journalAtom = Atom.family((args: SessionArgs) =>
  runtime.atom(
    Effect.fnUntraced(function*() {
      const client = yield* ApiClient
      const all: Array<JournalEvent> = []
      let after = 0
      for (;;) {
        const page = yield* client.agents.journal({
          params: { name: args.name, id: args.id },
          query: { after, limit: 500 },
        })
        all.push(...page.events)
        if (page.nextAfter === null) break
        after = page.nextAfter
      }
      return all
    })(),
  ),
)

/** A parked tool call awaiting a decision, enriched with its originating `tool-call`. `eventId` is the ENVELOPE `seq` of the `approval-requested` — the value POSTed to `/approve/:eventId`. */
export interface PendingApproval {
  readonly eventId: number
  readonly approvalId: string
  readonly toolCallId: string
  readonly turn: number
  readonly hop: number
  readonly toolName?: string
  readonly toolParams?: unknown
}

/**
 * Pure selector: the approvals still parked (an `approval-requested` envelope
 * with no matching `approval-resolved` for its `approvalId`). Each is enriched
 * with the `tool-call` sharing its `(turn, hop)` whose `part.id` matches the
 * `toolCallId`, so the card can render the tool name and params.
 */
export const pendingApprovals = (events: ReadonlyArray<JournalEvent>): ReadonlyArray<PendingApproval> => {
  const resolved = new Set<string>()
  for (const envelope of events) {
    if (envelope.event._tag === "approval-resolved") resolved.add(envelope.event.approvalId)
  }
  const pending: Array<PendingApproval> = []
  for (const envelope of events) {
    const event = envelope.event
    if (event._tag !== "approval-requested") continue
    if (resolved.has(event.approvalId)) continue
    const match = events.find(
      (candidate) =>
        candidate.event._tag === "tool-call" &&
        candidate.event.turn === event.turn &&
        candidate.event.hop === event.hop &&
        candidate.event.part.id === event.toolCallId,
    )
    const toolCall = match !== undefined && match.event._tag === "tool-call" ? match.event : undefined
    pending.push({
      eventId: envelope.seq,
      approvalId: event.approvalId,
      toolCallId: event.toolCallId,
      turn: event.turn,
      hop: event.hop,
      ...(toolCall !== undefined ? { toolName: toolCall.part.name, toolParams: toolCall.part.params } : {}),
    })
  }
  return pending
}

/**
 * Pure selector: each `tool-call` envelope paired with the `tool-result`
 * sharing its `(turn, hop)` whose `part.id` matches the call's `part.id`,
 * preserving tool-call order. `result` is present only once its matching
 * `tool-result` has been journalled (a call still in flight yields just `call`).
 */
export const toolCallResults = (
  events: ReadonlyArray<JournalEvent>,
): ReadonlyArray<{ call: JournalToolCall; result?: JournalToolResult }> => {
  const pairs: Array<{ call: JournalToolCall; result?: JournalToolResult }> = []
  for (const envelope of events) {
    const call = envelope.event
    if (call._tag !== "tool-call") continue
    const match = events.find(
      (candidate) =>
        candidate.event._tag === "tool-result" &&
        candidate.event.turn === call.turn &&
        candidate.event.hop === call.hop &&
        candidate.event.part.id === call.part.id,
    )
    const result = match !== undefined && match.event._tag === "tool-result" ? match.event : undefined
    pairs.push({ call, ...(result !== undefined ? { result } : {}) })
  }
  return pairs
}
