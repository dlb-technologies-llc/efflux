/**
 * Characterization pins for the `GET /attach` reattach path in `AttachStream.ts`:
 * the pure `projectJournalEvent` projection, the `analyzeJournal` reattach
 * decision (followed turn + open-at-attach resolution), and `runTail`'s stop
 * conditions (terminal, park, session-closed, not-open, staleness, absolute cap).
 * These freeze today's behaviour so a later dedup of the streaming/reattach
 * drivers cannot silently drift the projection totality or the tail cutoffs.
 *
 * `projectJournalEvent` is exercised two ways: a property over the codec-clean
 * `JournalEventPayload` members (asserting the display members thread their
 * fields and the non-display members are skipped) plus fixed representatives for
 * the members that embed a `Prompt` part or the `SafeName`-refined `user-message`
 * (whose `Schema.toArbitrary` would exhaust FastCheck's `.filter`). A totality
 * test then pins the exact 6-display / 7-skip partition against the schema's
 * member count.
 *
 * `analyzeJournal` and `runTail` are driven over a scripted `readJournal` stub
 * (canned pages, no live Durable Object) and `@effect/vitest`'s `TestClock` for
 * the time-based cutoffs — nothing here touches the real DO or a container.
 *
 * @module
 */
import { describe, expect, it } from "@effect/vitest"
import {
  JournalApprovalRequested,
  JournalApprovalResolved,
  JournalAssistantText,
  JournalCompaction,
  JournalDone,
  JournalErrorEvent,
  JournalEventPayload,
  JournalHopMessages,
  JournalSessionClosed,
  JournalTodoWrite,
  JournalToolCall,
  JournalToolResult,
  JournalUsage,
  JournalUserMessage,
  NonNegativeInt,
  StreamPartApprovalRequest,
  StreamPartDone,
  StreamPartError,
  StreamPartTextDelta,
  StreamPartToolCall,
  StreamPartToolResult,
  TodoItem,
} from "@efflux/shared"
import { type Cause, Duration, Effect, Exit, Option, Queue, Schema } from "effect"
import { TestClock } from "effect/testing"
import { Prompt } from "effect/unstable/ai"
import {
  analyzeJournal,
  type AttachFrame,
  type JournalReader,
  projectJournalEvent,
  runTail,
} from "./AttachStream.ts"
import { eventJson } from "./JournalWrite.ts"

/** Build one scripted journal row the way the DO returns it: schema-encoded JSON payload plus its seq. */
const row = (seq: number, event: JournalEventPayload): { seq: number; payload: string } => ({
  seq,
  payload: eventJson(event),
})

/**
 * A `JournalReader` backed by a fixed, ordered row list, paging exactly like the
 * real `readJournal`: rows with `seq > after`, capped at `limit`, `nextAfter`
 * non-null only when the page is full.
 */
const scriptedReader = (rows: ReadonlyArray<{ seq: number; payload: string }>): JournalReader => ({
  readJournal: ({ after, limit }) => {
    const page = rows.filter((r) => r.seq > after).slice(0, limit)
    const last = page[page.length - 1]
    const nextAfter = page.length === limit && last !== undefined ? last.seq : null
    return Promise.resolve({ events: page, nextAfter })
  },
})

/**
 * A `JournalReader` that yields one fresh non-display `usage` row on every read
 * (seq = after + 1) — an endlessly-active turn whose journal never goes stale,
 * so only the absolute cap can end the tail.
 */
const growingReader = (turn: number): JournalReader => ({
  readJournal: ({ after }) =>
    Promise.resolve({
      events: [row(after + 1, new JournalUsage({ turn, hop: 0, model: "m" }))],
      nextAfter: null,
    }),
})

/** Drain every frame currently queued without blocking (the queue is not ended in these tests). */
const drainFrames = (queue: Queue.Dequeue<AttachFrame, Cause.Done>) =>
  Effect.gen(function* () {
    const frames: Array<AttachFrame> = []
    for (;;) {
      const next = yield* Queue.poll(queue)
      if (Option.isNone(next)) break
      frames.push(next.value)
    }
    return frames
  })

/** Virtual-time step per `TestClock.adjust`, comfortably larger than any poll delay so one adjust drives exactly one tail iteration. */
const STEP_MILLIS = 30_000

/** Flush pending microtasks so a forked tail fiber resumes past its `Effect.promise` read and schedules its next `TestClock` sleep before the next adjust. */
const settle = Effect.gen(function* () {
  yield* Effect.yieldNow
  yield* Effect.yieldNow
  yield* Effect.yieldNow
})

const cleanPayload = Schema.Union([
  JournalAssistantText,
  JournalApprovalRequested,
  JournalApprovalResolved,
  JournalUsage,
  JournalDone,
  JournalErrorEvent,
  JournalSessionClosed,
  JournalTodoWrite,
  JournalCompaction,
])
const cleanArb = Schema.toArbitrary(cleanPayload)
const seqArb = Schema.toArbitrary(NonNegativeInt)

describe("projectJournalEvent", () => {
  it.effect.prop(
    "clean members: display tags thread fields, non-display tags are skipped",
    [seqArb, cleanArb],
    ([seq, event]) =>
      Effect.sync(() => {
        const part = projectJournalEvent(seq, event)
        switch (event._tag) {
          case "assistant-text":
            expect(part).toBeInstanceOf(StreamPartTextDelta)
            expect(part).toMatchObject({ _tag: "text-delta", delta: event.text })
            break
          case "approval-requested":
            expect(part).toBeInstanceOf(StreamPartApprovalRequest)
            expect(part).toMatchObject({
              _tag: "approval-request",
              eventId: seq,
              approvalId: event.approvalId,
              toolCallId: event.toolCallId,
            })
            break
          case "done":
            expect(part).toBeInstanceOf(StreamPartDone)
            expect(part).toMatchObject({
              _tag: "done",
              finishReason: event.finishReason,
              toolCallCount: event.toolCallCount,
            })
            break
          case "error":
            expect(part).toBeInstanceOf(StreamPartError)
            expect(part).toMatchObject({ _tag: "error", message: event.message })
            break
          default:
            expect(part).toBeUndefined()
        }
      }),
    { fastCheck: { numRuns: 200 } },
  )

  it.effect("pins tool-call -> StreamPartToolCall (id/name/params threaded)", () =>
    Effect.sync(() => {
      const event = new JournalToolCall({
        turn: 1,
        hop: 0,
        part: Prompt.toolCallPart({
          id: "call_1",
          name: "Bash",
          params: { command: "ls -la" },
          providerExecuted: false,
        }),
      })
      const part = projectJournalEvent(7, event)
      expect(part).toBeInstanceOf(StreamPartToolCall)
      expect(part).toMatchObject({
        _tag: "tool-call",
        id: "call_1",
        name: "Bash",
        params: { command: "ls -la" },
      })
    }))

  it.effect("pins tool-result -> StreamPartToolResult (id/result/isFailure threaded)", () =>
    Effect.sync(() => {
      const event = new JournalToolResult({
        turn: 1,
        hop: 0,
        part: Prompt.toolResultPart({
          id: "call_1",
          name: "Bash",
          isFailure: false,
          result: { stdout: "total 0", exitCode: 0 },
        }),
      })
      const part = projectJournalEvent(9, event)
      expect(part).toBeInstanceOf(StreamPartToolResult)
      expect(part).toMatchObject({
        _tag: "tool-result",
        id: "call_1",
        result: { stdout: "total 0", exitCode: 0 },
        isFailure: false,
      })
    }))

  it.effect("pins hop-messages -> undefined (non-display)", () =>
    Effect.sync(() =>
      expect(
        projectJournalEvent(
          3,
          new JournalHopMessages({
            turn: 1,
            hop: 0,
            messages: [Prompt.userMessage({ content: [Prompt.textPart({ text: "hi" })] })],
          }),
        ),
      ).toBeUndefined()))

  it.effect("pins user-message -> undefined (non-display)", () =>
    Effect.sync(() =>
      expect(
        projectJournalEvent(
          1,
          new JournalUserMessage({ content: "hello", skill: "code-review", role: "reviewer" }),
        ),
      ).toBeUndefined()))

  const displayTags = new Set([
    "assistant-text",
    "tool-call",
    "tool-result",
    "approval-requested",
    "done",
    "error",
  ])

  const allReps: ReadonlyArray<JournalEventPayload> = [
    new JournalAssistantText({ turn: 1, hop: 0, text: "t" }),
    new JournalToolCall({
      turn: 1,
      hop: 0,
      part: Prompt.toolCallPart({ id: "c1", name: "Bash", params: {}, providerExecuted: false }),
    }),
    new JournalToolResult({
      turn: 1,
      hop: 0,
      part: Prompt.toolResultPart({ id: "c1", name: "Bash", isFailure: false, result: {} }),
    }),
    new JournalApprovalRequested({ turn: 1, hop: 0, approvalId: "a", toolCallId: "c1" }),
    new JournalDone({ turn: 1, finishReason: "stop", toolCallCount: 1 }),
    new JournalErrorEvent({ turn: 1, message: "boom" }),
    new JournalUserMessage({ content: "hi" }),
    new JournalHopMessages({
      turn: 1,
      hop: 0,
      messages: [Prompt.userMessage({ content: [Prompt.textPart({ text: "hi" })] })],
    }),
    new JournalUsage({ turn: 1, hop: 0, model: "m" }),
    new JournalApprovalResolved({ turn: 1, approvalId: "a", approved: true }),
    new JournalTodoWrite({ turn: 1, items: [new TodoItem({ content: "x", status: "pending" })] }),
    new JournalCompaction({ throughSeq: 1, summary: "s" }),
    new JournalSessionClosed({ reason: "closed" }),
  ]

  it.effect("totality: exactly 6 tags produce a frame, 7 are skipped", () =>
    Effect.sync(() => {
      expect(JournalEventPayload.members.length).toBe(13)
      expect(new Set(allReps.map((e) => e._tag)).size).toBe(13)
      const displayed = allReps.filter((e) => projectJournalEvent(0, e) !== undefined)
      const skipped = allReps.filter((e) => projectJournalEvent(0, e) === undefined)
      expect(displayed.length).toBe(6)
      expect(skipped.length).toBe(7)
      expect(displayed.map((e) => e._tag).sort()).toStrictEqual([...displayTags].sort())
    }))
})

const analyze = (rows: ReadonlyArray<{ seq: number; payload: string }>) =>
  analyzeJournal(scriptedReader(rows))

describe("analyzeJournal — reattach decision", () => {
  it.effect("open turn: latest user-message, no terminal/park/close -> open", () =>
    Effect.gen(function* () {
      const result = yield* analyze([
        row(1, new JournalUserMessage({ content: "go" })),
        row(2, new JournalAssistantText({ turn: 1, hop: 0, text: "working" })),
      ])
      expect(result).toStrictEqual({ targetTurn: 1, openAtAttach: true })
    }))

  it.effect("terminal done on target turn -> not open", () =>
    Effect.gen(function* () {
      const result = yield* analyze([
        row(1, new JournalUserMessage({ content: "go" })),
        row(2, new JournalDone({ turn: 1, finishReason: "stop", toolCallCount: 0 })),
      ])
      expect(result).toStrictEqual({ targetTurn: 1, openAtAttach: false })
    }))

  it.effect("terminal error on target turn -> not open", () =>
    Effect.gen(function* () {
      const result = yield* analyze([
        row(1, new JournalUserMessage({ content: "go" })),
        row(2, new JournalErrorEvent({ turn: 1, message: "boom" })),
      ])
      expect(result).toStrictEqual({ targetTurn: 1, openAtAttach: false })
    }))

  it.effect("unresolved parked approval on target turn -> not open", () =>
    Effect.gen(function* () {
      const result = yield* analyze([
        row(1, new JournalUserMessage({ content: "go" })),
        row(2, new JournalApprovalRequested({ turn: 1, hop: 0, approvalId: "a", toolCallId: "c" })),
      ])
      expect(result).toStrictEqual({ targetTurn: 1, openAtAttach: false })
    }))

  it.effect("resolved approval reopens the turn", () =>
    Effect.gen(function* () {
      const result = yield* analyze([
        row(1, new JournalUserMessage({ content: "go" })),
        row(2, new JournalApprovalRequested({ turn: 1, hop: 0, approvalId: "a", toolCallId: "c" })),
        row(3, new JournalApprovalResolved({ turn: 1, approvalId: "a", approved: true })),
      ])
      expect(result).toStrictEqual({ targetTurn: 1, openAtAttach: true })
    }))

  it.effect("session-closed -> not open", () =>
    Effect.gen(function* () {
      const result = yield* analyze([
        row(1, new JournalUserMessage({ content: "go" })),
        row(2, new JournalSessionClosed({ reason: "closed" })),
      ])
      expect(result).toStrictEqual({ targetTurn: 1, openAtAttach: false })
    }))

  it.effect("no user messages -> no target turn, not open", () =>
    Effect.gen(function* () {
      const result = yield* analyze([row(1, new JournalUsage({ turn: 0, hop: 0, model: "m" }))])
      expect(result).toStrictEqual({ targetTurn: undefined, openAtAttach: false })
    }))

  it.effect("target is the LATEST user-message; an earlier turn's terminal is ignored", () =>
    Effect.gen(function* () {
      const result = yield* analyze([
        row(1, new JournalUserMessage({ content: "first" })),
        row(2, new JournalDone({ turn: 1, finishReason: "stop", toolCallCount: 0 })),
        row(3, new JournalUserMessage({ content: "second" })),
      ])
      expect(result).toStrictEqual({ targetTurn: 3, openAtAttach: true })
    }))

  it.effect("latest turn terminal -> not open", () =>
    Effect.gen(function* () {
      const result = yield* analyze([
        row(1, new JournalUserMessage({ content: "first" })),
        row(2, new JournalUserMessage({ content: "second" })),
        row(3, new JournalDone({ turn: 2, finishReason: "stop", toolCallCount: 0 })),
      ])
      expect(result).toStrictEqual({ targetTurn: 2, openAtAttach: false })
    }))

  it.effect("a park on an EARLIER turn does not close the latest turn", () =>
    Effect.gen(function* () {
      const result = yield* analyze([
        row(1, new JournalUserMessage({ content: "first" })),
        row(2, new JournalApprovalRequested({ turn: 1, hop: 0, approvalId: "a", toolCallId: "c" })),
        row(3, new JournalUserMessage({ content: "second" })),
      ])
      expect(result).toStrictEqual({ targetTurn: 3, openAtAttach: true })
    }))
})

describe("runTail — stop conditions (single-page, no clock)", () => {
  it.effect("terminal done on target turn replays then stops", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.bounded<AttachFrame, Cause.Done>(64)
      yield* runTail({
        agent: scriptedReader([
          row(1, new JournalUserMessage({ content: "go" })),
          row(2, new JournalAssistantText({ turn: 1, hop: 0, text: "hi" })),
          row(3, new JournalDone({ turn: 1, finishReason: "stop", toolCallCount: 1 })),
        ]),
        queue,
        startCursor: 0,
        targetTurn: 1,
        openAtAttach: true,
      })
      const frames = yield* drainFrames(queue)
      expect(frames.map((f) => f.sse._tag)).toStrictEqual(["text-delta", "done"])
      expect(frames[frames.length - 1]?.seq).toBe(3)
      expect(frames[frames.length - 1]?.sse).toBeInstanceOf(StreamPartDone)
    }))

  it.effect("terminal error on target turn replays then stops", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.bounded<AttachFrame, Cause.Done>(64)
      yield* runTail({
        agent: scriptedReader([
          row(1, new JournalUserMessage({ content: "go" })),
          row(2, new JournalErrorEvent({ turn: 1, message: "boom" })),
        ]),
        queue,
        startCursor: 0,
        targetTurn: 1,
        openAtAttach: true,
      })
      const frames = yield* drainFrames(queue)
      expect(frames.map((f) => f.sse._tag)).toStrictEqual(["error"])
      expect(frames[0]?.sse).toBeInstanceOf(StreamPartError)
    }))

  it.effect("session-closed stops the tail (no frame emitted)", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.bounded<AttachFrame, Cause.Done>(64)
      yield* runTail({
        agent: scriptedReader([
          row(1, new JournalUserMessage({ content: "go" })),
          row(2, new JournalSessionClosed({ reason: "reaped" })),
        ]),
        queue,
        startCursor: 0,
        targetTurn: 1,
        openAtAttach: true,
      })
      const frames = yield* drainFrames(queue)
      expect(frames).toStrictEqual([])
    }))

  it.effect("unresolved parked approval on target turn stops after replay", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.bounded<AttachFrame, Cause.Done>(64)
      yield* runTail({
        agent: scriptedReader([
          row(1, new JournalUserMessage({ content: "go" })),
          row(2, new JournalApprovalRequested({ turn: 1, hop: 0, approvalId: "a", toolCallId: "c" })),
        ]),
        queue,
        startCursor: 0,
        targetTurn: 1,
        openAtAttach: true,
      })
      const frames = yield* drainFrames(queue)
      expect(frames.map((f) => f.sse._tag)).toStrictEqual(["approval-request"])
      expect(frames[0]?.sse).toBeInstanceOf(StreamPartApprovalRequest)
      expect(frames[0]?.sse).toMatchObject({ eventId: 2, approvalId: "a", toolCallId: "c" })
      expect(frames[0]?.seq).toBe(2)
    }))

  it.effect("not open at attach: replays then closes without live-tailing", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.bounded<AttachFrame, Cause.Done>(64)
      yield* runTail({
        agent: scriptedReader([
          row(1, new JournalUserMessage({ content: "go" })),
          row(2, new JournalAssistantText({ turn: 1, hop: 0, text: "replay only" })),
        ]),
        queue,
        startCursor: 0,
        targetTurn: 1,
        openAtAttach: false,
      })
      const frames = yield* drainFrames(queue)
      expect(frames.map((f) => f.sse._tag)).toStrictEqual(["text-delta"])
    }))
})

describe("runTail — time-based cutoffs (TestClock)", () => {
  it.effect("staleness cutoff ends the tail once the journal goes quiet", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.bounded<AttachFrame, Cause.Done>(64)
      const fiber = yield* runTail({
        agent: scriptedReader([
          row(1, new JournalUserMessage({ content: "go" })),
          row(2, new JournalAssistantText({ turn: 1, hop: 0, text: "working" })),
        ]),
        queue,
        startCursor: 0,
        targetTurn: 1,
        openAtAttach: true,
      }).pipe(Effect.forkChild({ startImmediately: true }))

      yield* settle
      for (let i = 0; i < 3; i++) {
        yield* TestClock.adjust(Duration.millis(STEP_MILLIS))
        yield* settle
      }
      expect(fiber.pollUnsafe()).toBeUndefined()

      for (let i = 0; i < 200; i++) {
        if (fiber.pollUnsafe() !== undefined) break
        yield* TestClock.adjust(Duration.millis(STEP_MILLIS))
        yield* settle
      }
      const exit = fiber.pollUnsafe()
      expect(exit).toBeDefined()
      if (exit !== undefined) expect(Exit.isSuccess(exit)).toBe(true)
    }))

  it.effect("absolute cap ends the tail even while rows keep arriving", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.bounded<AttachFrame, Cause.Done>(64)
      const fiber = yield* runTail({
        agent: growingReader(1),
        queue,
        startCursor: 0,
        targetTurn: 1,
        openAtAttach: true,
      }).pipe(Effect.forkChild({ startImmediately: true }))

      yield* settle
      for (let i = 0; i < 20; i++) {
        yield* TestClock.adjust(Duration.millis(STEP_MILLIS))
        yield* settle
      }
      expect(fiber.pollUnsafe()).toBeUndefined()

      for (let i = 0; i < 200; i++) {
        if (fiber.pollUnsafe() !== undefined) break
        yield* TestClock.adjust(Duration.millis(STEP_MILLIS))
        yield* settle
      }
      const exit = fiber.pollUnsafe()
      expect(exit).toBeDefined()
      if (exit !== undefined) expect(Exit.isSuccess(exit)).toBe(true)
    }))
})
