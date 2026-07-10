import { Schema } from "effect"
import { Prompt, Response as AiResponse } from "effect/unstable/ai"
import { NonNegativeInt, SafeName } from "./Schemas.ts"

/** Turn-opening user message; snapshots the overlay (skill/role/model) so a parked turn's system messages reload by name. */
export class JournalUserMessage extends Schema.TaggedClass<JournalUserMessage>()(
  "user-message",
  {
    content: Schema.String,
    skill: Schema.optionalKey(SafeName),
    role: Schema.optionalKey(SafeName),
    model: Schema.optionalKey(Schema.String),
  },
) {}

/** Assistant text emitted during a hop. */
export class JournalAssistantText extends Schema.TaggedClass<JournalAssistantText>()(
  "assistant-text",
  {
    turn: NonNegativeInt,
    hop: NonNegativeInt,
    text: Schema.String,
  },
) {}

/** A tool call the model requested — granular layer, embeds the encoded `Prompt.ToolCallPart`. */
export class JournalToolCall extends Schema.TaggedClass<JournalToolCall>()(
  "tool-call",
  {
    turn: NonNegativeInt,
    hop: NonNegativeInt,
    part: Prompt.ToolCallPart,
  },
) {}

/** A tool call's result — granular layer, embeds the encoded `Prompt.ToolResultPart`. */
export class JournalToolResult extends Schema.TaggedClass<JournalToolResult>()(
  "tool-result",
  {
    turn: NonNegativeInt,
    hop: NonNegativeInt,
    part: Prompt.ToolResultPart,
  },
) {}

/** A tool call parked awaiting approval; `toolCallId` matches the `JournalToolCall` in the same (turn, hop). */
export class JournalApprovalRequested extends Schema.TaggedClass<JournalApprovalRequested>()(
  "approval-requested",
  {
    turn: NonNegativeInt,
    hop: NonNegativeInt,
    approvalId: Schema.String,
    toolCallId: Schema.String,
  },
) {}

/** Resolution of a parked approval (granted or denied). */
export class JournalApprovalResolved extends Schema.TaggedClass<JournalApprovalResolved>()(
  "approval-resolved",
  {
    turn: NonNegativeInt,
    approvalId: Schema.String,
    approved: Schema.Boolean,
    reason: Schema.optionalKey(Schema.String),
  },
) {}

/** Authoritative per-hop `Prompt.Message`s for lossless prompt rebuild of a parked turn. */
export class JournalHopMessages extends Schema.TaggedClass<JournalHopMessages>()(
  "hop-messages",
  {
    turn: NonNegativeInt,
    hop: NonNegativeInt,
    messages: Schema.Array(Prompt.Message),
  },
) {}

/** Per-hop usage accounting; `cost` is USD from OpenRouter's raw accounting when present. */
export class JournalUsage extends Schema.TaggedClass<JournalUsage>()("usage", {
  turn: NonNegativeInt,
  hop: NonNegativeInt,
  model: Schema.String,
  inputTokens: Schema.optionalKey(NonNegativeInt),
  outputTokens: Schema.optionalKey(NonNegativeInt),
  totalTokens: Schema.optionalKey(NonNegativeInt),
  cost: Schema.optionalKey(Schema.Number),
}) {}

/** Terminal event for a turn. */
export class JournalDone extends Schema.TaggedClass<JournalDone>()("done", {
  turn: NonNegativeInt,
  finishReason: AiResponse.FinishReason,
  toolCallCount: NonNegativeInt,
}) {}

/** A turn-level error. */
export class JournalErrorEvent extends Schema.TaggedClass<JournalErrorEvent>()(
  "error",
  {
    turn: NonNegativeInt,
    message: Schema.String,
  },
) {}

/** Terminal session-lifecycle event: the session was closed explicitly (`closed`) or reaped by the TTL alarm (`reaped`). Captured in the archived journal; never present in a live journal (close writes it, archives, then purges). */
export class JournalSessionClosed extends Schema.TaggedClass<JournalSessionClosed>()(
  "session-closed",
  {
    reason: Schema.Literals(["closed", "reaped"]),
  },
) {}

/** One task-list entry the model maintains via the todo tools; `status` mirrors the standard todo lifecycle. */
export class TodoItem extends Schema.Class<TodoItem>("TodoItem")({
  content: Schema.String.check(Schema.isMaxLength(2000)),
  status: Schema.Literals(["pending", "in_progress", "completed"]),
}) {}

/** The session task list at one instant — the model replaces it wholesale via `todo_write`. The latest `todo-write` is the live list: injected into every turn and preserved verbatim through compaction. Capped so the injected list can't dwarf the context it survives. */
export class JournalTodoWrite extends Schema.TaggedClass<JournalTodoWrite>()("todo-write", {
  turn: NonNegativeInt,
  items: Schema.Array(TodoItem).check(Schema.isMaxLength(100)),
}) {}

/** A context-compaction checkpoint: `summary` folds every turn whose user-message seq ≤ `throughSeq` into prose; the history fold then serves `summary + turns after throughSeq`. Turn-less — compaction runs BETWEEN turns, never within one. The summary is written pre-capped (`capForPrompt`); the schema bound is a backstop since it re-injects into every later prompt and chains into every later compaction. */
export class JournalCompaction extends Schema.TaggedClass<JournalCompaction>()("compaction", {
  throughSeq: NonNegativeInt,
  summary: Schema.String.check(Schema.isMaxLength(40_000)),
}) {}

/** Prefix marking the injected compaction summary; shared by the DO history fold and the approve-path reconstruction so they never drift. */
export const COMPACTION_SUMMARY_PREFIX = "Summary of the conversation so far:\n\n"

/**
 * The append-only event vocabulary persisted in the Agent DO's SQLite journal;
 * history is a fold over these. Two prompt-reconstruction layers coexist:
 * GRANULAR `tool-call`/`tool-result` events embed encoded `Prompt` part schemas
 * for per-call timelines and approvals; AUTHORITATIVE `hop-messages` stores the
 * exact per-hop `Prompt.Message`s for lossless rebuild. Every event but
 * `user-message` and `compaction` carries `turn`; folds group by `(turn, hop)`,
 * never seq adjacency (concurrent prompts to one session interleave appends).
 * The terminal `session-closed` member is archive-only — close writes it into
 * the archived journal, then purges the live journal, so it never appears live.
 */
export const JournalEventPayload = Schema.Union([
  JournalUserMessage,
  JournalAssistantText,
  JournalToolCall,
  JournalToolResult,
  JournalApprovalRequested,
  JournalApprovalResolved,
  JournalHopMessages,
  JournalUsage,
  JournalDone,
  JournalErrorEvent,
  JournalSessionClosed,
  JournalTodoWrite,
  JournalCompaction,
])

export type JournalEventPayload = typeof JournalEventPayload.Type

/** Envelope for one journal row: `seq` is the SQLite AUTOINCREMENT key (monotonic, never reused — Last-Event-ID safe), `createdAt` is epoch ms. */
export class JournalEvent extends Schema.Class<JournalEvent>("JournalEvent")({
  seq: NonNegativeInt,
  createdAt: NonNegativeInt,
  event: JournalEventPayload,
}) {}

/** A page of journal events; `nextAfter` is the cursor for the next page (pass as `?after=`), null when this is the last page. */
export class JournalResponse extends Schema.Class<JournalResponse>("JournalResponse")({
  events: Schema.Array(JournalEvent),
  nextAfter: Schema.NullOr(Schema.Number),
}) {}

/** Registry entry for one session. */
export class SessionInfo extends Schema.Class<SessionInfo>("SessionInfo")({
  name: Schema.String,
  id: Schema.String,
  createdAt: NonNegativeInt,
  lastActiveAt: NonNegativeInt,
}) {}

/** All known sessions. */
export class SessionsResponse extends Schema.Class<SessionsResponse>("SessionsResponse")({
  sessions: Schema.Array(SessionInfo),
}) {}

/** One archived session — the eval-corpus record written to `effect-flue-sessions/archives/<name>/<id>/<closedAt>/journal.json` on close or reap. `events` is the full journal at close time (including the terminal `session-closed` event). */
export class SessionArchive extends Schema.Class<SessionArchive>("SessionArchive")({
  name: Schema.String,
  id: Schema.String,
  closedAt: NonNegativeInt,
  reason: Schema.Literals(["closed", "reaped"]),
  events: Schema.Array(JournalEvent),
}) {}
