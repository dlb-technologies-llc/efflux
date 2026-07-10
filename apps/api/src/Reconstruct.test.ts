/**
 * Characterization pins for parked-turn prompt reconstruction
 * ({@link reconstructForContinuation} + {@link maxHopForTurn}).
 *
 * These freeze the EXACT current output — message roles in order, the folded
 * prior-turn text, hop ordering, approval-request filtering, and the trailing
 * tool-approval-response — so W7's O(n²)→linear rewrite of the reconstruction
 * can prove it preserved behavior. Inputs are built with the real Journal event
 * constructors and the real `Prompt` part/message constructors; assertions read
 * the structural invariants of the resulting `Prompt` rather than its symbol-
 * keyed internals.
 *
 * @module
 */
import { describe, expect, it } from "@effect/vitest"
import {
  COMPACTION_SUMMARY_PREFIX,
  JournalApprovalRequested,
  JournalAssistantText,
  JournalCompaction,
  JournalHopMessages,
  JournalUserMessage,
} from "@effect-flue/shared"
import { Effect } from "effect"
import { Prompt } from "effect/unstable/ai"
import { maxHopForTurn, type ReconstructEvent, reconstructForContinuation } from "./Reconstruct.ts"

/** Assistant hop message that requested approval for a single tool call. */
const parkedAssistant = (toolCallId: string, approvalId: string): Prompt.AssistantMessage =>
  Prompt.assistantMessage({
    content: [
      Prompt.toolCallPart({ id: toolCallId, name: "Bash", params: {}, providerExecuted: false }),
      Prompt.toolApprovalRequestPart({ approvalId, toolCallId }),
    ],
  })

/** Assistant hop message with a single completed tool call (no approval gate). */
const callingAssistant = (toolCallId: string): Prompt.AssistantMessage =>
  Prompt.assistantMessage({
    content: [Prompt.toolCallPart({ id: toolCallId, name: "Bash", params: {}, providerExecuted: false })],
  })

/** Tool hop message carrying one tool result for `toolCallId`. */
const resultMessage = (toolCallId: string): Prompt.ToolMessage =>
  Prompt.toolMessage({
    content: [Prompt.toolResultPart({ id: toolCallId, name: "Bash", isFailure: false, result: "ok" })],
  })

/** Roles of the reconstructed messages, in order. */
const roleSequence = (prompt: Prompt.Prompt): ReadonlyArray<string> =>
  prompt.content.map((message) => message.role)

/** Every system message's text body, in order. */
const systemContents = (prompt: Prompt.Prompt): ReadonlyArray<string> => {
  const out: Array<string> = []
  for (const message of prompt.content) {
    if (message.role === "system") out.push(message.content)
  }
  return out
}

/** Text of each user message's first text part, in order. */
const userTexts = (prompt: Prompt.Prompt): ReadonlyArray<string> => {
  const out: Array<string> = []
  for (const message of prompt.content) {
    if (message.role !== "user") continue
    for (const part of message.content) {
      if (part.type === "text") {
        out.push(part.text)
        break
      }
    }
  }
  return out
}

/** Tool-call ids across all assistant messages, in message-then-part order. */
const toolCallSequence = (prompt: Prompt.Prompt): ReadonlyArray<string> => {
  const out: Array<string> = []
  for (const message of prompt.content) {
    if (message.role !== "assistant") continue
    for (const part of message.content) {
      if (part.type === "tool-call") out.push(part.id)
    }
  }
  return out
}

/** True when some assistant message still carries an approval-request for `toolCallId`. */
const hasApprovalRequestFor = (prompt: Prompt.Prompt, toolCallId: string): boolean =>
  prompt.content.some(
    (message) =>
      message.role === "assistant" &&
      message.content.some(
        (part) => part.type === "tool-approval-request" && part.toolCallId === toolCallId,
      ),
  )

/** True when some assistant message carries a tool-call with `id`. */
const hasToolCall = (prompt: Prompt.Prompt, id: string): boolean =>
  prompt.content.some(
    (message) =>
      message.role === "assistant" &&
      message.content.some((part) => part.type === "tool-call" && part.id === id),
  )

/** The trailing tool-approval-response part the continuation appends, if present. */
const approvalResponse = (prompt: Prompt.Prompt): Prompt.ToolApprovalResponsePart | undefined => {
  for (const message of prompt.content) {
    if (message.role !== "tool") continue
    for (const part of message.content) {
      if (part.type === "tool-approval-response") return part
    }
  }
  return undefined
}

describe("reconstructForContinuation", () => {
  it.effect("single-hop parked turn keeps the unresolved approval request", () =>
    Effect.sync(() => {
      const events: ReadonlyArray<ReconstructEvent> = [
        { seq: 1, event: new JournalUserMessage({ content: "list files" }) },
        {
          seq: 2,
          event: new JournalHopMessages({
            turn: 1,
            hop: 0,
            messages: [parkedAssistant("call_1", "appr_1")],
          }),
        },
        {
          seq: 3,
          event: new JournalApprovalRequested({ turn: 1, hop: 0, approvalId: "appr_1", toolCallId: "call_1" }),
        },
      ]

      const prompt = reconstructForContinuation({
        events,
        parkedTurn: 1,
        approvalId: "appr_1",
        approved: true,
        skillBody: "SKILL",
        roleBody: undefined,
      })

      expect(roleSequence(prompt)).toStrictEqual(["system", "user", "assistant", "tool"])
      expect(systemContents(prompt)).toStrictEqual(["SKILL"])
      expect(userTexts(prompt)).toStrictEqual(["list files"])
      expect(hasApprovalRequestFor(prompt, "call_1")).toBe(true)

      const response = approvalResponse(prompt)
      expect(response?.approvalId).toBe("appr_1")
      expect(response?.approved).toBe(true)
      expect(response?.reason).toBeUndefined()
    }))

  it.effect("multi-hop parked turn folds prior turns and orders hops by hop number", () =>
    Effect.sync(() => {
      const priorUser: ReconstructEvent = { seq: 1, event: new JournalUserMessage({ content: "first turn" }) }
      const priorText: ReconstructEvent = {
        seq: 2,
        event: new JournalAssistantText({ turn: 1, hop: 0, text: "prior answer" }),
      }
      const parkedUser: ReconstructEvent = { seq: 3, event: new JournalUserMessage({ content: "parked turn msg" }) }
      const hop0: ReconstructEvent = {
        seq: 4,
        event: new JournalHopMessages({
          turn: 3,
          hop: 0,
          messages: [callingAssistant("call_0"), resultMessage("call_0")],
        }),
      }
      const hop1: ReconstructEvent = {
        seq: 5,
        event: new JournalHopMessages({ turn: 3, hop: 1, messages: [parkedAssistant("call_1", "appr_1")] }),
      }
      const requested: ReconstructEvent = {
        seq: 6,
        event: new JournalApprovalRequested({ turn: 3, hop: 1, approvalId: "appr_1", toolCallId: "call_1" }),
      }

      const events: ReadonlyArray<ReconstructEvent> = [requested, hop1, hop0, parkedUser, priorText, priorUser]

      expect(maxHopForTurn(events, 3)).toBe(1)
      expect(maxHopForTurn(events, 1)).toBe(0)
      expect(maxHopForTurn(events, 99)).toBe(-1)

      const prompt = reconstructForContinuation({
        events,
        parkedTurn: 3,
        approvalId: "appr_1",
        approved: true,
        skillBody: "SKILL",
        roleBody: "ROLE",
      })

      expect(roleSequence(prompt)).toStrictEqual([
        "system",
        "system",
        "user",
        "assistant",
        "user",
        "assistant",
        "tool",
        "assistant",
        "tool",
      ])
      expect(systemContents(prompt)).toStrictEqual(["SKILL", "ROLE"])
      expect(userTexts(prompt)).toStrictEqual(["first turn", "parked turn msg"])
      expect(toolCallSequence(prompt)).toStrictEqual(["call_0", "call_1"])
      expect(hasApprovalRequestFor(prompt, "call_1")).toBe(true)
    }))

  it.effect("resolved approval filters the request part out of its assistant message", () =>
    Effect.sync(() => {
      const events: ReadonlyArray<ReconstructEvent> = [
        { seq: 1, event: new JournalUserMessage({ content: "resolved case" }) },
        {
          seq: 2,
          event: new JournalHopMessages({
            turn: 1,
            hop: 0,
            messages: [parkedAssistant("call_1", "appr_1"), resultMessage("call_1")],
          }),
        },
        {
          seq: 3,
          event: new JournalApprovalRequested({ turn: 1, hop: 0, approvalId: "appr_1", toolCallId: "call_1" }),
        },
      ]

      const prompt = reconstructForContinuation({
        events,
        parkedTurn: 1,
        approvalId: "appr_1",
        approved: true,
        skillBody: "SKILL",
        roleBody: undefined,
      })

      expect(roleSequence(prompt)).toStrictEqual(["system", "user", "assistant", "tool", "tool"])
      expect(hasApprovalRequestFor(prompt, "call_1")).toBe(false)
      expect(hasToolCall(prompt, "call_1")).toBe(true)
      expect(approvalResponse(prompt)?.approved).toBe(true)
    }))

  it.effect("denied resolution carries approved:false and its reason", () =>
    Effect.sync(() => {
      const events: ReadonlyArray<ReconstructEvent> = [
        { seq: 1, event: new JournalUserMessage({ content: "list files" }) },
        {
          seq: 2,
          event: new JournalHopMessages({
            turn: 1,
            hop: 0,
            messages: [parkedAssistant("call_1", "appr_1")],
          }),
        },
        {
          seq: 3,
          event: new JournalApprovalRequested({ turn: 1, hop: 0, approvalId: "appr_1", toolCallId: "call_1" }),
        },
      ]

      const prompt = reconstructForContinuation({
        events,
        parkedTurn: 1,
        approvalId: "appr_1",
        approved: false,
        reason: "denied by user",
        skillBody: "SKILL",
        roleBody: undefined,
      })

      expect(roleSequence(prompt)).toStrictEqual(["system", "user", "assistant", "tool"])

      const response = approvalResponse(prompt)
      expect(response?.approvalId).toBe("appr_1")
      expect(response?.approved).toBe(false)
      expect(response?.reason).toBe("denied by user")
    }))

  it.effect("honors the compaction watermark: drops pre-watermark users and injects the summary", () =>
    Effect.sync(() => {
      const events: ReadonlyArray<ReconstructEvent> = [
        { seq: 1, event: new JournalUserMessage({ content: "dropped turn" }) },
        { seq: 2, event: new JournalCompaction({ throughSeq: 1, summary: "user asked X; agent did Y" }) },
        { seq: 3, event: new JournalUserMessage({ content: "kept prior" }) },
        { seq: 4, event: new JournalAssistantText({ turn: 3, hop: 0, text: "kept answer" }) },
        { seq: 5, event: new JournalUserMessage({ content: "parked turn msg" }) },
        {
          seq: 6,
          event: new JournalHopMessages({ turn: 5, hop: 0, messages: [parkedAssistant("call_1", "appr_1")] }),
        },
        {
          seq: 7,
          event: new JournalApprovalRequested({ turn: 5, hop: 0, approvalId: "appr_1", toolCallId: "call_1" }),
        },
      ]

      const prompt = reconstructForContinuation({
        events,
        parkedTurn: 5,
        approvalId: "appr_1",
        approved: true,
        skillBody: "SKILL",
        roleBody: undefined,
      })

      expect(roleSequence(prompt)).toStrictEqual([
        "system",
        "user",
        "user",
        "assistant",
        "user",
        "assistant",
        "tool",
      ])
      expect(userTexts(prompt)).not.toContain("dropped turn")
      expect(userTexts(prompt).some((text) => text.startsWith(COMPACTION_SUMMARY_PREFIX))).toBe(true)
      expect(userTexts(prompt)).toContain("kept prior")
      expect(userTexts(prompt)).toContain("parked turn msg")
    }))

  it.effect("injects the todos system message and orders skill/role, todos, summary, then prior users", () =>
    Effect.sync(() => {
      const events: ReadonlyArray<ReconstructEvent> = [
        { seq: 1, event: new JournalUserMessage({ content: "dropped turn" }) },
        { seq: 2, event: new JournalCompaction({ throughSeq: 1, summary: "folded history" }) },
        { seq: 3, event: new JournalUserMessage({ content: "kept prior" }) },
        { seq: 4, event: new JournalUserMessage({ content: "parked turn msg" }) },
        {
          seq: 5,
          event: new JournalHopMessages({ turn: 4, hop: 0, messages: [parkedAssistant("call_1", "appr_1")] }),
        },
        {
          seq: 6,
          event: new JournalApprovalRequested({ turn: 4, hop: 0, approvalId: "appr_1", toolCallId: "call_1" }),
        },
      ]

      const prompt = reconstructForContinuation({
        events,
        parkedTurn: 4,
        approvalId: "appr_1",
        approved: true,
        skillBody: "SKILL",
        roleBody: "ROLE",
        todos: "- [ ] x",
      })

      expect(roleSequence(prompt)).toStrictEqual([
        "system",
        "system",
        "system",
        "user",
        "user",
        "user",
        "assistant",
        "tool",
      ])
      expect(systemContents(prompt)).toStrictEqual(["SKILL", "ROLE", "Current task list:\n- [ ] x"])
      expect(systemContents(prompt)[2]?.startsWith("Current task list:")).toBe(true)
      expect(userTexts(prompt)).toStrictEqual([
        `${COMPACTION_SUMMARY_PREFIX}folded history`,
        "kept prior",
        "parked turn msg",
      ])
    }))
})
