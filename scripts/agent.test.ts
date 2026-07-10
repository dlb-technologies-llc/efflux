/**
 * Ground-truth pins for the pure {@link formatEvent} journal renderer exported by
 * `./agent.ts`.
 *
 * Each row freezes the EXACT one-line string the renderer emits today for one
 * representative event of every `JournalEventPayload` member, computed by running
 * the real implementation over events built with the real Journal + `Prompt`
 * constructors — not a re-derivation — so a future edit to the rendering (field
 * order, the `turn=N hop=N` prefix, the `FAILED`/`ok` and `APPROVED`/`DENIED`
 * words, the `?`/`$` token-and-cost fallbacks, the two-space separators) breaks a
 * pin instead of silently drifting the CLI journal dump.
 *
 * `formatEvent` is total and pure over `JournalEvent`; the head embeds
 * `new Date(createdAt).toISOString()`, so every case fixes `createdAt` at epoch 0
 * (`1970-01-01T00:00:00.000Z`) to keep the pinned strings deterministic. Both
 * branches of the optional fields are covered: user-message with and without
 * `skill`/`model`, tool-result `ok` vs `FAILED`, approval `APPROVED` vs `DENIED`
 * with and without a reason, and usage with and without token/cost fields.
 *
 * A final runtime guard asserts the pinned tag set equals `JournalEventPayload`'s
 * full set of literal `_tag`s — derived from the schema's members, not a hand-typed
 * list — so adding a 14th member without also pinning a case fails this test loudly.
 *
 * @module
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { Prompt } from "effect/unstable/ai"
import {
  JournalApprovalRequested,
  JournalApprovalResolved,
  JournalAssistantText,
  JournalCompaction,
  JournalDone,
  JournalErrorEvent,
  JournalEvent,
  JournalEventPayload,
  JournalHopMessages,
  JournalSessionClosed,
  JournalTodoWrite,
  JournalToolCall,
  JournalToolResult,
  JournalUsage,
  JournalUserMessage,
  TodoItem,
} from "../packages/shared/src/index.ts"
import { formatEvent } from "./agent.ts"

/** Envelope one payload at epoch-0 `createdAt` so the rendered ISO head is fixed. */
const ev = (seq: number, event: JournalEvent["event"]): JournalEvent => new JournalEvent({ seq, createdAt: 0, event })

const cases: ReadonlyArray<readonly [string, JournalEvent, string]> = [
  [
    "user-message with skill/role/model",
    ev(1, new JournalUserMessage({ content: "run the build", skill: "code-review", role: "reviewer", model: "openai/gpt-4o-mini" })),
    `#1  1970-01-01T00:00:00.000Z  user-message  "run the build"  skill=code-review  model=openai/gpt-4o-mini`,
  ],
  [
    "user-message bare content",
    ev(2, new JournalUserMessage({ content: "hi" })),
    `#2  1970-01-01T00:00:00.000Z  user-message  "hi"`,
  ],
  [
    "assistant-text",
    ev(3, new JournalAssistantText({ turn: 1, hop: 0, text: "hello world" })),
    `#3  1970-01-01T00:00:00.000Z  assistant-text  turn=1 hop=0  "hello world"`,
  ],
  [
    "tool-call",
    ev(4, new JournalToolCall({ turn: 1, hop: 0, part: Prompt.toolCallPart({ id: "call_1", name: "Bash", params: { command: "ls -la" }, providerExecuted: false }) })),
    `#4  1970-01-01T00:00:00.000Z  tool-call  turn=1 hop=0  Bash({"command":"ls -la"})  callId=call_1`,
  ],
  [
    "tool-result ok",
    ev(5, new JournalToolResult({ turn: 1, hop: 0, part: Prompt.toolResultPart({ id: "call_1", name: "Bash", isFailure: false, result: { stdout: "ok", exitCode: 0 } }) })),
    `#5  1970-01-01T00:00:00.000Z  tool-result  turn=1 hop=0  Bash ok  callId=call_1`,
  ],
  [
    "tool-result failed",
    ev(6, new JournalToolResult({ turn: 1, hop: 0, part: Prompt.toolResultPart({ id: "call_2", name: "Bash", isFailure: true, result: "boom" }) })),
    `#6  1970-01-01T00:00:00.000Z  tool-result  turn=1 hop=0  Bash FAILED  callId=call_2`,
  ],
  [
    "approval-requested",
    ev(7, new JournalApprovalRequested({ turn: 1, hop: 0, approvalId: "appr_1", toolCallId: "call_1" })),
    `#7  1970-01-01T00:00:00.000Z  approval-requested  turn=1 hop=0  approvalId=appr_1 callId=call_1`,
  ],
  [
    "approval-resolved approved",
    ev(8, new JournalApprovalResolved({ turn: 1, approvalId: "appr_1", approved: true })),
    `#8  1970-01-01T00:00:00.000Z  approval-resolved  turn=1  APPROVED approvalId=appr_1`,
  ],
  [
    "approval-resolved denied with reason",
    ev(9, new JournalApprovalResolved({ turn: 1, approvalId: "appr_2", approved: false, reason: "denied by user" })),
    `#9  1970-01-01T00:00:00.000Z  approval-resolved  turn=1  DENIED approvalId=appr_2  denied by user`,
  ],
  [
    "hop-messages",
    ev(10, new JournalHopMessages({ turn: 1, hop: 0, messages: [Prompt.userMessage({ content: [Prompt.textPart({ text: "hello" })] }), Prompt.assistantMessage({ content: [Prompt.textPart({ text: "hi" })] })] })),
    `#10  1970-01-01T00:00:00.000Z  hop-messages  turn=1 hop=0  2 prompt message(s): user, assistant`,
  ],
  [
    "usage with tokens and cost",
    ev(11, new JournalUsage({ turn: 1, hop: 0, model: "openai/gpt-4o-mini", inputTokens: 10, outputTokens: 20, totalTokens: 30, cost: 0.0001 })),
    `#11  1970-01-01T00:00:00.000Z  usage  turn=1 hop=0  model=openai/gpt-4o-mini  in=10 out=20 total=30  cost=$0.0001`,
  ],
  [
    "usage without tokens or cost",
    ev(12, new JournalUsage({ turn: 1, hop: 0, model: "tencent/hy3:free" })),
    `#12  1970-01-01T00:00:00.000Z  usage  turn=1 hop=0  model=tencent/hy3:free  in=? out=? total=?`,
  ],
  [
    "done",
    ev(13, new JournalDone({ turn: 1, finishReason: "stop", toolCallCount: 2 })),
    `#13  1970-01-01T00:00:00.000Z  done  turn=1  stop  toolCalls=2`,
  ],
  [
    "error",
    ev(14, new JournalErrorEvent({ turn: 1, message: "boom happened" })),
    `#14  1970-01-01T00:00:00.000Z  error  turn=1  boom happened`,
  ],
  [
    "session-closed reaped",
    ev(15, new JournalSessionClosed({ reason: "reaped" })),
    `#15  1970-01-01T00:00:00.000Z  session-closed  reason=reaped`,
  ],
  [
    "todo-write",
    ev(16, new JournalTodoWrite({ turn: 1, items: [new TodoItem({ content: "write tests", status: "in_progress" }), new TodoItem({ content: "ship it", status: "pending" })] })),
    `#16  1970-01-01T00:00:00.000Z  todo-write  turn=1  2 item(s): [in_progress] write tests; [pending] ship it`,
  ],
  [
    "compaction",
    ev(17, new JournalCompaction({ throughSeq: 5, summary: "folded five turns" })),
    `#17  1970-01-01T00:00:00.000Z  compaction  throughSeq=5  "folded five turns"`,
  ],
]

describe("formatEvent", () => {
  for (const [label, event, expected] of cases) {
    it.effect(label, () => Effect.sync(() => expect(formatEvent(event)).toBe(expected)))
  }

  it.effect("pins one case for every JournalEventPayload member", () =>
    Effect.sync(() => {
      const covered = new Set(cases.map(([, journalEvent]) => journalEvent.event._tag))
      const all = new Set(JournalEventPayload.members.map((member) => member.fields._tag.schema.literal))
      expect([...covered].sort()).toEqual([...all].sort())
    }))
})
