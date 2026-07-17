/**
 * Pure, I/O-free core of the eval harness: distills a session journal into a
 * comparable behavioral trajectory, extracts replay inputs, diffs a replayed
 * candidate against the archived baseline, and shapes/parses the LLM-judge
 * prompt. No `Effect`, no fetch, no `process`, no clock — deterministic and
 * safe to import from tests.
 */

import type { JournalEvent, SessionArchive } from "../packages/shared/src/index.ts"

/** One turn's observable behavior distilled from journal events: the ordered tool-call names, the terminal finish reason, and whether the turn errored. `turn` is the originating user-message seq (the journal's `turn === user-message.seq` invariant). */
export interface TurnTrajectory {
  readonly turn: number
  readonly tools: ReadonlyArray<string>
  readonly finishReason: string | undefined
  readonly errored: boolean
}

/** The three outcomes an LLM judge can report when comparing baseline vs candidate answers. */
export type JudgeVerdict = "equivalent" | "different" | "inconclusive"

/** Mutable per-turn accumulator built while folding journal events; frozen into a `TurnTrajectory` at the end. */
interface TurnAccumulator {
  tools: Array<string>
  finishReason: string | undefined
  errored: boolean
}

/** Character budget for each answer body inside the judge prompt; keeps the total under the `/tasks` prompt cap. */
const ANSWER_BUDGET = 2500

/** Character budget for the joined user turns inside the judge prompt. */
const USER_TURNS_BUDGET = 1500

/** Visible marker appended when a value is clipped to its budget. */
const TRUNCATION_MARKER = "…[truncated]"

/** Matches a `VERDICT:`-bearing line and captures the first run of letters after any leading punctuation. */
const VERDICT_PATTERN = /verdict\s*:\s*[^a-z0-9]*([a-z]+)/i

/** Return a seq-ascending copy of the events without mutating the input. */
const bySeq = (events: ReadonlyArray<JournalEvent>): ReadonlyArray<JournalEvent> =>
  [...events].sort((a, b) => a.seq - b.seq)

/** Structural equality over two tool-name sequences (order and count both significant). */
const sameTools = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/** Clip `value` to `budget` characters, appending {@link TRUNCATION_MARKER} when it was cut. */
const clip = (value: string, budget: number): string =>
  value.length > budget ? `${value.slice(0, budget)}${TRUNCATION_MARKER}` : value

/**
 * Group the turn-bearing events by `event.turn` and distill each turn's
 * observable behavior: tool-call `part.name`s in ascending `seq` order (empty
 * when the turn made no calls), the `finishReason` from the turn's `done` event
 * (`undefined` if absent), and whether an `error` event exists for the turn.
 * Turns are returned sorted ascending by `turn`. Used for both the archived
 * baseline and the replayed candidate.
 */
export const extractTrajectory = (
  events: ReadonlyArray<JournalEvent>,
): ReadonlyArray<TurnTrajectory> => {
  const byTurn = new Map<number, TurnAccumulator>()
  const ensure = (turn: number): TurnAccumulator => {
    let acc = byTurn.get(turn)
    if (acc === undefined) {
      acc = { tools: [], finishReason: undefined, errored: false }
      byTurn.set(turn, acc)
    }
    return acc
  }

  for (const { event } of bySeq(events)) {
    switch (event._tag) {
      case "tool-call":
        ensure(event.turn).tools.push(event.part.name)
        break
      case "done":
        ensure(event.turn).finishReason = event.finishReason
        break
      case "error":
        ensure(event.turn).errored = true
        break
      case "assistant-text":
      case "tool-result":
      case "approval-requested":
      case "approval-resolved":
      case "hop-messages":
      case "usage":
      case "todo-write":
        ensure(event.turn)
        break
      case "user-message":
      case "compaction":
        break
    }
  }

  const trajectories: Array<TurnTrajectory> = []
  for (const [turn, acc] of byTurn) {
    trajectories.push({ turn, tools: acc.tools, finishReason: acc.finishReason, errored: acc.errored })
  }
  trajectories.sort((a, b) => a.turn - b.turn)
  return trajectories
}

/**
 * The model's final reply: the `assistant-text` of the LAST turn (greatest
 * `turn` value that has any assistant-text) concatenated across its hops in
 * ascending `seq` order. Empty string when there is no assistant-text at all.
 */
export const finalAnswer = (events: ReadonlyArray<JournalEvent>): string => {
  let lastTurn: number | undefined = undefined
  for (const { event } of events) {
    if (event._tag === "assistant-text") {
      if (lastTurn === undefined || event.turn > lastTurn) lastTurn = event.turn
    }
  }
  if (lastTurn === undefined) return ""

  const parts: Array<string> = []
  for (const { event } of bySeq(events)) {
    if (event._tag === "assistant-text" && event.turn === lastTurn) parts.push(event.text)
  }
  return parts.join("")
}

/**
 * The ordered `user-message` contents (in `seq` order) — the replay inputs.
 * The baseline model/skill/role are intentionally NOT carried; the candidate
 * run overrides them.
 */
export const extractUserTurns = (
  archive: SessionArchive,
): ReadonlyArray<{ readonly content: string }> => {
  const turns: Array<{ readonly content: string }> = []
  for (const { event } of bySeq(archive.events)) {
    if (event._tag === "user-message") turns.push({ content: event.content })
  }
  return turns
}

/**
 * Pair the baseline and candidate trajectories by index and record a
 * human-readable difference whenever, for a paired turn, the tool-name
 * sequences differ (order or count), the `finishReason` differs, or the
 * `errored` flag differs; a turn-count mismatch is also recorded. `matches`
 * is true iff no differences were found.
 */
export const diffTrajectory = (
  baseline: ReadonlyArray<TurnTrajectory>,
  candidate: ReadonlyArray<TurnTrajectory>,
): { readonly matches: boolean; readonly differences: ReadonlyArray<string> } => {
  const differences: Array<string> = []
  const paired = Math.min(baseline.length, candidate.length)
  for (let i = 0; i < paired; i++) {
    const base = baseline[i]
    const cand = candidate[i]
    if (base === undefined || cand === undefined) continue
    if (!sameTools(base.tools, cand.tools)) {
      differences.push(
        `turn ${base.turn}: tools [${base.tools.join(", ")}] -> [${cand.tools.join(", ")}]`,
      )
    }
    if (base.finishReason !== cand.finishReason) {
      differences.push(
        `turn ${base.turn}: finishReason ${base.finishReason} -> ${cand.finishReason}`,
      )
    }
    if (base.errored !== cand.errored) {
      differences.push(`turn ${base.turn}: errored ${base.errored} -> ${cand.errored}`)
    }
  }
  if (baseline.length !== candidate.length) {
    differences.push(`turn count ${baseline.length} -> ${candidate.length}`)
  }
  return { matches: differences.length === 0, differences }
}

/**
 * Build the LLM-judge instruction that compares the baseline answer against the
 * candidate answer given the user turns, ending with a demand for a strict
 * final line `VERDICT: EQUIVALENT` or `VERDICT: DIFFERENT`. Answers and the
 * joined user turns are clipped to fixed budgets so the returned string always
 * stays under the 8192-character `/tasks` prompt cap regardless of input size.
 */
export const buildJudgePrompt = (input: {
  userTurns: ReadonlyArray<string>
  baselineAnswer: string
  candidateAnswer: string
}): string => {
  const userTurns = clip(input.userTurns.join("\n---\n"), USER_TURNS_BUDGET)
  const baseline = clip(input.baselineAnswer, ANSWER_BUDGET)
  const candidate = clip(input.candidateAnswer, ANSWER_BUDGET)
  return [
    "You are an impartial judge comparing two AI assistant answers to the same conversation.",
    "",
    "Conversation (user turns):",
    userTurns,
    "",
    "Baseline answer:",
    baseline,
    "",
    "Candidate answer:",
    candidate,
    "",
    "Decide whether the candidate answer is EQUIVALENT to the baseline answer in meaning and",
    "helpfulness, or DIFFERENT. Minor wording changes are still EQUIVALENT; a change in facts,",
    "conclusions, or whether the task was accomplished is DIFFERENT.",
    "",
    "Explain your reasoning briefly, then end with a single final line that is exactly one of:",
    "VERDICT: EQUIVALENT",
    "VERDICT: DIFFERENT",
  ].join("\n")
}

/**
 * Scan `text` for a `VERDICT:`-bearing line and map its value to a
 * {@link JudgeVerdict}: `EQUIVALENT` → `"equivalent"`, `DIFFERENT` →
 * `"different"`, anything else or absent → `"inconclusive"`. Case-insensitive
 * and tolerant of surrounding whitespace and punctuation; the last resolvable
 * line wins. Never throws.
 */
export const parseJudgeVerdict = (text: string): JudgeVerdict => {
  let result: JudgeVerdict = "inconclusive"
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(VERDICT_PATTERN)
    if (match === null) continue
    const value = match[1]
    if (value === undefined) continue
    const normalized = value.toLowerCase()
    if (normalized === "equivalent") result = "equivalent"
    else if (normalized === "different") result = "different"
  }
  return result
}
