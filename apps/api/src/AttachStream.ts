import {
  type JournalEventPayload,
  StreamPart,
  StreamPartApprovalRequest,
  StreamPartDone,
  StreamPartError,
  StreamPartTextDelta,
  StreamPartToolCall,
  StreamPartToolResult,
} from "@efflux/shared"
import { type Cause, Clock, Duration, Effect, Queue, Schema, Stream } from "effect"
import { Sse } from "effect/unstable/encoding"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { MAX_TOOL_HOPS, MODEL_HOP_TIMEOUT } from "./AgentLoop.ts"
import type { AgentNamespace } from "./AgentStub.ts"
import { decodeEventPayload } from "./JournalWrite.ts"

/**
 * Pure journal reader for `GET /attach`: it projects journaled events back into
 * SSE `StreamPart` frames and live-tails the journal. It drives NO model and
 * builds NO toolkit/AI layer — a leaked tail fiber only polls the DO until a
 * stop condition, so it never appends and never continues a turn.
 */

/** SSE encoder for the wire `StreamPart` union — the same encode the live streaming path uses. */
const encodeStreamPart = Schema.encodeSync(StreamPart)

/**
 * Absolute wall-clock ceiling for one attach tail: the model loop's own budget
 * (`MAX_TOOL_HOPS` rounds, each bounded by `MODEL_HOP_TIMEOUT`). Past this the
 * tail stops even without a terminal — a runaway or reaped turn cannot pin the
 * fiber open forever.
 */
const ATTACH_TAIL_CAP_MILLIS = Duration.toMillis(MODEL_HOP_TIMEOUT) * MAX_TOOL_HOPS

/**
 * No new journal row for this long ends the tail — bounds the "isolate reaped,
 * terminal never written" case. It MUST exceed `MODEL_HOP_TIMEOUT`: a live turn
 * can be journal-silent for a whole hop (text deltas are not journaled; a hop's
 * only writes are its inline tool events and the hop-end batch), so a shorter
 * cutoff would drop a healthy mid-inference turn. A single tool call that runs
 * longer than this window is the residual case that stops early — the client
 * simply re-attaches.
 */
const STALENESS_CUTOFF_MILLIS = Duration.toMillis(MODEL_HOP_TIMEOUT) + 30_000

/** Poll cadence while rows are still arriving (replay + hot tail). */
const POLL_FAST_MILLIS = 300

/** Steady-state poll cadence once caught up — the DO is single-threaded, so idle polling stays gentle. */
const POLL_SLOW_MILLIS = 1_000

/** Backoff step applied to the poll delay on each empty poll, walking it from fast toward slow. */
const POLL_BACKOFF_STEP_MILLIS = 200

/** Journal page size — matches the `fetchAllEvents` paging idiom. */
const PAGE_LIMIT = 500

/** One SSE frame candidate: the display part plus its backing journal seq (the SSE frame id / Last-Event-ID). */
export type AttachFrame = { readonly sse: StreamPart; readonly seq: number }

/**
 * The minimal journal-reader seam `analyzeJournal` and `runTail` consume: one
 * paged `readJournal` RPC returning raw rows (payloads stay JSON text across the
 * RPC fence) plus the next-page cursor (null on the last page). The live `Agent`
 * DO stub satisfies it structurally; unit tests supply a scripted page source.
 * Narrowing to this seam keeps the pure replay/tail logic testable without a
 * live Durable Object — it changes no behavior, only the accepted argument type.
 */
export type JournalReader = {
  readJournal(input: { after: number; limit: number }): Promise<{
    readonly events: ReadonlyArray<{ readonly seq: number; readonly payload: string }>
    readonly nextAfter: number | null
  }>
}

/**
 * Project one journaled event into its SSE `StreamPart`, or `undefined` when the
 * event carries no display frame. Total over every `JournalEventPayload` `_tag`:
 * six map to a frame, the rest are non-display and skipped. `seq` is the frame id
 * the caller stamps (the journal row's seq).
 */
export const projectJournalEvent = (
  seq: number,
  event: JournalEventPayload,
): StreamPart | undefined => {
  switch (event._tag) {
    case "assistant-text":
      return new StreamPartTextDelta({ delta: event.text })
    case "tool-call":
      return new StreamPartToolCall({
        id: event.part.id,
        name: event.part.name,
        params: event.part.params,
      })
    case "tool-result":
      return new StreamPartToolResult({
        id: event.part.id,
        result: event.part.result,
        isFailure: event.part.isFailure,
      })
    case "approval-requested":
      return new StreamPartApprovalRequest({
        eventId: seq,
        approvalId: event.approvalId,
        toolCallId: event.toolCallId,
      })
    case "done":
      return new StreamPartDone({
        finishReason: event.finishReason,
        toolCallCount: event.toolCallCount,
      })
    case "error":
      return new StreamPartError({ message: event.message })
    case "user-message":
    case "hop-messages":
    case "usage":
    case "approval-resolved":
    case "todo-write":
    case "compaction":
    case "session-closed":
      return undefined
    default: {
      const _exhaustive: never = event
      return _exhaustive
    }
  }
}

/** The followed turn plus whether it is still OPEN (in-progress) at attach time. */
type JournalAnalysis = {
  /** LATEST `user-message` seq — the turn a bare `/attach` follows — or `undefined` when the session has no user messages yet. */
  readonly targetTurn: number | undefined
  /**
   * True only when there is a target turn that is genuinely still running: no
   * terminal (`done`/`error`) for it, no unresolved parked approval, and no
   * `session-closed`. When false there is nothing to live-tail, so the tail must
   * close right after replaying — otherwise a session with no in-flight turn (or
   * an explicit cursor already past the terminal) would poll to the staleness cap.
   */
  readonly openAtAttach: boolean
}

/**
 * One front-to-back scan of the journal computing the followed turn (max
 * `user-message` seq) and whether it is still open at attach time. Terminal,
 * park, and closed state are collected per turn during the pass and resolved
 * against the target turn at the end (the target is only known once the last
 * `user-message` is seen).
 */
export const analyzeJournal = (agent: JournalReader): Effect.Effect<JournalAnalysis> =>
  Effect.gen(function* () {
    let after = 0
    let targetTurn: number | undefined
    const terminalTurns = new Set<number>()
    const pendingApprovalsByTurn = new Map<number, Set<string>>()
    let sessionClosed = false
    for (;;) {
      const page = yield* Effect.promise(() => agent.readJournal({ after, limit: PAGE_LIMIT }))
      for (const row of page.events) {
        const event = yield* decodeEventPayload(JSON.parse(row.payload)).pipe(Effect.orDie)
        switch (event._tag) {
          case "user-message":
            targetTurn = row.seq
            break
          case "done":
          case "error":
            terminalTurns.add(event.turn)
            break
          case "session-closed":
            sessionClosed = true
            break
          case "approval-requested": {
            const set = pendingApprovalsByTurn.get(event.turn) ?? new Set<string>()
            set.add(event.approvalId)
            pendingApprovalsByTurn.set(event.turn, set)
            break
          }
          case "approval-resolved":
            pendingApprovalsByTurn.get(event.turn)?.delete(event.approvalId)
            break
          default:
            break
        }
      }
      if (page.nextAfter === null) break
      after = page.nextAfter
    }
    const parked =
      targetTurn !== undefined && (pendingApprovalsByTurn.get(targetTurn)?.size ?? 0) > 0
    const terminal = targetTurn !== undefined && terminalTurns.has(targetTurn)
    const openAtAttach = targetTurn !== undefined && !terminal && !parked && !sessionClosed
    return { targetTurn, openAtAttach }
  })

/**
 * Replay-then-live-tail driver: pages the journal from `startCursor`, offering
 * each projected frame onto `queue`, then polls for new rows until the followed
 * turn terminates, parks on an unresolved approval, the session closes, the
 * journal goes stale, or the absolute cap is hit. Ends by returning; the caller
 * closes the queue via `Effect.ensuring`.
 */
export const runTail = (input: {
  agent: JournalReader
  queue: Queue.Enqueue<AttachFrame, Cause.Done>
  startCursor: number
  targetTurn: number | undefined
  openAtAttach: boolean
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    const { agent, openAtAttach, queue, startCursor, targetTurn } = input
    const startMillis = yield* Clock.currentTimeMillis
    const deadlineMillis = startMillis + ATTACH_TAIL_CAP_MILLIS

    let after = startCursor
    let lastActivityMillis = startMillis
    let pollDelayMillis = POLL_FAST_MILLIS
    const pendingApprovals = new Set<string>()

    for (;;) {
      const now = yield* Clock.currentTimeMillis
      if (now >= deadlineMillis) return
      if (now - lastActivityMillis >= STALENESS_CUTOFF_MILLIS) return

      const page = yield* Effect.promise(() => agent.readJournal({ after, limit: PAGE_LIMIT }))

      let stop = false
      for (const row of page.events) {
        const event = yield* decodeEventPayload(JSON.parse(row.payload)).pipe(Effect.orDie)

        const sse = projectJournalEvent(row.seq, event)
        if (sse !== undefined) yield* Queue.offer(queue, { sse, seq: row.seq })

        if (event._tag === "approval-requested" && event.turn === targetTurn) {
          pendingApprovals.add(event.approvalId)
        }
        if (event._tag === "approval-resolved" && event.turn === targetTurn) {
          pendingApprovals.delete(event.approvalId)
        }

        if (event._tag === "session-closed") {
          stop = true
          break
        }
        if ((event._tag === "done" || event._tag === "error") && event.turn === targetTurn) {
          stop = true
          break
        }
      }

      const lastRow = page.events[page.events.length - 1]
      if (lastRow !== undefined) lastActivityMillis = yield* Clock.currentTimeMillis
      if (page.nextAfter !== null) after = page.nextAfter
      else if (lastRow !== undefined) after = lastRow.seq

      if (stop) return
      if (page.nextAfter !== null) continue

      if (!openAtAttach) return
      if (pendingApprovals.size > 0) return

      pollDelayMillis =
        lastRow !== undefined
          ? POLL_FAST_MILLIS
          : Math.min(POLL_SLOW_MILLIS, pollDelayMillis + POLL_BACKOFF_STEP_MILLIS)
      yield* Effect.sleep(Duration.millis(pollDelayMillis))
    }
  })

/**
 * SSE response for `GET /attach`: replays the followed turn in full then
 * live-tails the journal. `after` (when given) is the resume cursor; a bare
 * attach (`after` undefined) rewinds to just before the latest `user-message`
 * so the newest turn replays in full. The followed turn is fixed at first read,
 * so a later concurrent turn never extends this tail.
 */
export const runAttachStream = (input: {
  agent: ReturnType<AgentNamespace["getByName"]>
  after: number | undefined
}): HttpServerResponse.HttpServerResponse => {
  const { agent, after: initialAfter } = input

  const sseFrames = Stream.unwrap(
    Effect.gen(function* () {
      const { openAtAttach, targetTurn } = yield* analyzeJournal(agent)
      const startCursor =
        initialAfter !== undefined
          ? initialAfter
          : targetTurn !== undefined
            ? targetTurn - 1
            : 0

      const queue = yield* Queue.bounded<AttachFrame, Cause.Done>(64)

      yield* runTail({ agent, queue, startCursor, targetTurn, openAtAttach }).pipe(
        Effect.ensuring(Queue.end(queue)),
        Effect.forkScoped,
      )

      return Stream.fromQueue(queue).pipe(
        Stream.map(({ seq, sse }) =>
          Sse.encoder.write({
            _tag: "Event",
            event: "message",
            id: String(seq),
            data: JSON.stringify(encodeStreamPart(sse)),
          }),
        ),
        Stream.encodeText,
      )
    }),
  )

  return HttpServerResponse.stream(sseFrames, {
    contentType: "text/event-stream",
    headers: { "cache-control": "no-cache", "x-accel-buffering": "no" },
  })
}
