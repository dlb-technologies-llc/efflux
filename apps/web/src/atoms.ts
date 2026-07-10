import {
  ApprovalDecision,
  makePromptRequest,
  PromptRequest,
  StreamPart,
  streamAgentSse,
  streamAgentSseFramed,
} from "@efflux/shared"
import { Effect, Ref, Schema, Stream } from "effect"
import { HttpBody, HttpClient } from "effect/unstable/http"
import { Atom } from "effect/unstable/reactivity"
import { ApiClient, runtime } from "./runtime.ts"
import type { SessionArgs } from "./session.ts"

const encodePromptRequest = Schema.encodeSync(PromptRequest)

/**
 * Query atom (per-session): load persisted history. `Atom.family` memoises via
 * `MutableHashMap` (structural `Equal`/`Hash`), so each unique `{name, id}`
 * returns the same underlying atom and the fetch fires on first subscribe.
 */
export const historyAtom = Atom.family((args: SessionArgs) =>
  runtime.atom(
    Effect.fnUntraced(function*() {
      const client = yield* ApiClient
      return yield* client.agents.history({ params: { name: args.name, id: args.id } })
    })(),
  ),
)

/** Empty typed seed for the streaming accumulator (avoids an `as` cast). */
export const noParts: ReadonlyArray<StreamPart> = []

/** Grow the running transcript by one decoded frame; the atom republishes the whole array each event so the consumer never concatenates tokens by hand. */
const appendPart = (parts: ReadonlyArray<StreamPart>, part: StreamPart): ReadonlyArray<StreamPart> => [...parts, part]

/** A turn's terminal frames — once one is seen the turn is over and no `/attach` reconnect may follow. */
const isTerminalTag = (tag: StreamPart["_tag"]): boolean => tag === "done" || tag === "error"

/** Cap on `/attach` reconnect attempts so a dead turn can never reconnect forever. */
const MAX_ATTACH_ATTEMPTS = 3

/** Short backoff between `/attach` reconnect attempts. */
const ATTACH_BACKOFF = "500 millis"

/** POST-segment reconnect gate: flip `sawTerminal` on a `done`/`error` frame — and on an `approval-request`, since a park halts the turn pending user approval (the approve flow opens a fresh stream), so no bare `/attach` reconnect should follow a park the client already saw. A drop BEFORE the park never sees this frame, so it still reconnects and replays up to the park. */
const recordTerminal = (part: StreamPart, sawTerminal: Ref.Ref<boolean>) =>
  isTerminalTag(part._tag) || part._tag === "approval-request"
    ? Ref.set(sawTerminal, true)
    : Effect.void

/**
 * Attach-segment bookkeeping for one reconnect attempt: mark that this attempt produced a frame
 * (progress-gating), and stop the reconnect loop on a terminal or `approval-request` frame — a
 * terminal frame additionally flips `sawTerminal` so the loop can never reconnect again.
 */
const recordAttachFrame = (
  part: StreamPart,
  sawTerminal: Ref.Ref<boolean>,
  stopped: Ref.Ref<boolean>,
  progress: Ref.Ref<boolean>,
) =>
  Effect.gen(function*() {
    yield* Ref.set(progress, true)
    if (isTerminalTag(part._tag)) {
      yield* Ref.set(sawTerminal, true)
      yield* Ref.set(stopped, true)
    } else if (part._tag === "approval-request") {
      yield* Ref.set(stopped, true)
    }
  })

/**
 * Bounded, replace-not-append `/attach` reconnect loop shared by `streamAtom`
 * (POST-drop resume) and `resumeAtom` (load-time resume). Each attempt opens a
 * bare `GET /attach`, `Stream.scan`s from a FRESH `noParts` seed so it REPLACES
 * the transcript (appending would double-render the dropped hop), and recurses
 * only while the attempt made progress and saw no terminal/park. `sawTerminal`
 * is threaded so a `done`/`error` frame permanently halts reconnects.
 */
const attachTail = (
  client: HttpClient.HttpClient,
  attachUrl: string,
  sawTerminal: Ref.Ref<boolean>,
  attemptsLeft: number,
): Stream.Stream<ReadonlyArray<StreamPart>> =>
  Stream.unwrap(
    Effect.gen(function*() {
      if (attemptsLeft <= 0) return Stream.empty
      if (yield* Ref.get(sawTerminal)) return Stream.empty
      yield* Effect.sleep(ATTACH_BACKOFF)
      const progress = yield* Ref.make(false)
      const stopped = yield* Ref.make(false)
      const segment = streamAgentSseFramed(client.get(attachUrl), StreamPart).pipe(
        Stream.tap((frame) => recordAttachFrame(frame.data, sawTerminal, stopped, progress)),
        Stream.map((frame) => frame.data),
        Stream.scan(noParts, appendPart),
        Stream.catchCause(() => Stream.empty),
      )
      const continuation = Stream.unwrap(
        Effect.gen(function*() {
          if (yield* Ref.get(sawTerminal)) return Stream.empty
          if (yield* Ref.get(stopped)) return Stream.empty
          if (!(yield* Ref.get(progress))) return Stream.empty
          return attachTail(client, attachUrl, sawTerminal, attemptsLeft - 1)
        }),
      )
      return Stream.concat(segment, continuation)
    }),
  )

/**
 * Stream atom: POST the prompt to `/agents/:name/:id/stream` and emit the
 * accumulated `StreamPart[]` after each event, transparently resuming an
 * in-flight turn if the POST stream drops before a terminal frame.
 *
 * The transport is fully Effect: `HttpClient` + the shared `streamAgentSseFramed`
 * (built on `effect/unstable/encoding/Sse`, symmetric with the server's
 * `Sse.encoder`) — no raw `fetch`, no hand-rolled parser, decode failures in
 * the Stream error channel. `Stream.scan` makes the atom own accumulation, so
 * each published value is the whole transcript-so-far: the consumer just reads
 * the latest array (no manual token concatenation), and multi-event SSE chunks
 * can never drop a token the way a last-element-per-chunk value atom would.
 *
 * Reconnect: a single `sawTerminal` `Ref` tracks whether a `done`/`error` frame
 * was seen. If the POST segment ends without one, the atom reconnects to a bare
 * `GET /agents/:name/:id/attach` (latest-turn mode — NO `Last-Event-ID`, no
 * `?after`), which replays the newest turn IN FULL from the journal then
 * live-tails. Each attach segment `Stream.scan`s from a FRESH `noParts` seed so
 * it REPLACES the interrupted transcript (appending would double-render the
 * dropped hop's text). Reconnects are bounded by `MAX_ATTACH_ATTEMPTS` with a
 * short backoff and per-attempt progress-gating (an attach that emits zero
 * frames means the turn is gone — stop), and never fire once `sawTerminal` is
 * true. The published value stays `ReadonlyArray<StreamPart>` throughout.
 */
export const streamAtom = runtime.fn(
  (
    args: SessionArgs & {
      readonly message: string
      readonly model?: string
      readonly skill?: string
      readonly role?: string
    },
  ) =>
    Stream.unwrap(
      Effect.gen(function*() {
        const client = yield* HttpClient.HttpClient
        const sawTerminal = yield* Ref.make(false)
        const streamUrl = `/agents/${encodeURIComponent(args.name)}/${encodeURIComponent(args.id)}/stream`
        const attachUrl = `/agents/${encodeURIComponent(args.name)}/${encodeURIComponent(args.id)}/attach`
        const body = HttpBody.text(
          JSON.stringify(encodePromptRequest(makePromptRequest(args.message, args))),
          "application/json",
        )
        const postSegment = streamAgentSseFramed(client.post(streamUrl, { body }), StreamPart).pipe(
          Stream.tap((frame) => recordTerminal(frame.data, sawTerminal)),
          Stream.map((frame) => frame.data),
          Stream.scan(noParts, appendPart),
          Stream.catchCause(() => Stream.empty),
        )
        return Stream.concat(postSegment, attachTail(client, attachUrl, sawTerminal, MAX_ATTACH_ATTEMPTS))
      }),
    ),
)

/**
 * Load-time resume: open a bare `GET /attach` and live-tail the session's latest
 * turn into an accumulated `StreamPart[]`, sharing `streamAtom`'s replace-not-
 * append `attachTail` loop (fresh `sawTerminal`, so the first attach fires). The
 * caller starts this only when `latestTurnInFlight` says the newest turn has no
 * terminal in the journal, so a completed session never replays.
 */
export const resumeAtom = runtime.fn((args: SessionArgs) =>
  Stream.unwrap(
    Effect.gen(function*() {
      const client = yield* HttpClient.HttpClient
      const sawTerminal = yield* Ref.make(false)
      const attachUrl = `/agents/${encodeURIComponent(args.name)}/${encodeURIComponent(args.id)}/attach`
      return attachTail(client, attachUrl, sawTerminal, MAX_ATTACH_ATTEMPTS)
    }),
  ),
)

const encodeApprovalDecision = Schema.encodeSync(ApprovalDecision)

/** POST an approval decision to /approve/:eventId and emit the continuation turn as an accumulated StreamPart[] — symmetric with streamAtom (same SSE transport, same Stream.scan accumulator). */
export const approveStreamAtom = runtime.fn(
  (
    args: SessionArgs & {
      readonly eventId: number
      readonly approved: boolean
      readonly reason?: string
    },
  ) =>
    Stream.unwrap(
      Effect.gen(function*() {
        const client = yield* HttpClient.HttpClient
        const url = `/agents/${encodeURIComponent(args.name)}/${encodeURIComponent(args.id)}/approve/${args.eventId}`
        const decision = new ApprovalDecision({
          approved: args.approved,
          ...(args.reason !== undefined ? { reason: args.reason } : {}),
        })
        const body = HttpBody.text(JSON.stringify(encodeApprovalDecision(decision)), "application/json")
        return streamAgentSse(client.post(url, { body }), StreamPart).pipe(
          Stream.scan(noParts, (parts, part) => [...parts, part]),
        )
      }),
    ),
)
