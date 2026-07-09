import type { JournalEventPayload } from "@effect-flue/shared"
import { Prompt } from "effect/unstable/ai"

/**
 * Pure prompt reconstruction for approve-and-continue (#40): rebuild the exact
 * continuation prompt for a PARKED turn from decoded {@link ReconstructEvent}s
 * via {@link reconstructForContinuation} — no I/O; skill/role bodies are passed in.
 */

/** One decoded journal row (seq + payload) — the handler decodes rows to this. */
export interface ReconstructEvent {
  readonly seq: number
  readonly event: JournalEventPayload
}

/**
 * Rebuild the continuation prompt for the PARKED turn identified by
 * `parkedTurn` (the seq of that turn's `user-message` event), resolving the
 * approval `approvalId` with the given decision.
 */
export const reconstructForContinuation = (input: {
  events: ReadonlyArray<ReconstructEvent>
  parkedTurn: number
  approvalId: string
  approved: boolean
  reason?: string
  skillBody: string
  roleBody: string | undefined
}): Prompt.Prompt => {
  const { approvalId, approved, events, parkedTurn, reason, roleBody, skillBody } = input

  const bySeq = [...events].sort((a, b) => a.seq - b.seq)

  const messages: Array<Prompt.Message> = []

  messages.push(Prompt.systemMessage({ content: skillBody }))
  if (roleBody !== undefined) {
    messages.push(Prompt.systemMessage({ content: roleBody }))
  }

  for (const { event, seq } of bySeq) {
    if (event._tag !== "user-message" || seq >= parkedTurn) continue
    messages.push(Prompt.userMessage({ content: [Prompt.textPart({ text: event.content })] }))
    const texts: Array<string> = []
    for (const { event: priorEvent } of bySeq) {
      if (priorEvent._tag === "assistant-text" && priorEvent.turn === seq) {
        texts.push(priorEvent.text)
      }
    }
    if (texts.length > 0) {
      messages.push(Prompt.assistantMessage({ content: [Prompt.textPart({ text: texts.join("") })] }))
    }
  }

  for (const { event, seq } of bySeq) {
    if (seq === parkedTurn && event._tag === "user-message") {
      messages.push(Prompt.userMessage({ content: [Prompt.textPart({ text: event.content })] }))
      break
    }
  }

  const resolvedToolCallIds = new Set<string>()
  for (const { event } of bySeq) {
    if (event._tag === "tool-result" && event.turn === parkedTurn) {
      resolvedToolCallIds.add(event.part.id)
    } else if (event._tag === "hop-messages" && event.turn === parkedTurn) {
      for (const message of event.messages) {
        if (message.role === "tool") {
          for (const part of message.content) {
            if (part.type === "tool-result") resolvedToolCallIds.add(part.id)
          }
        }
      }
    }
  }

  const parkedHops: Array<{ hop: number; messages: ReadonlyArray<Prompt.Message> }> = []
  for (const { event } of bySeq) {
    if (event._tag === "hop-messages" && event.turn === parkedTurn) {
      parkedHops.push({ hop: event.hop, messages: event.messages })
    }
  }
  parkedHops.sort((a, b) => a.hop - b.hop)

  for (const { messages: hopMessages } of parkedHops) {
    for (const message of hopMessages) {
      if (message.role !== "assistant") {
        messages.push(message)
        continue
      }
      const filtered = message.content.filter(
        (part) => !(part.type === "tool-approval-request" && resolvedToolCallIds.has(part.toolCallId)),
      )
      if (filtered.length === message.content.length) {
        messages.push(message)
      } else if (filtered.length > 0) {
        messages.push(Prompt.assistantMessage({ content: filtered }))
      }
    }
  }

  messages.push(
    Prompt.toolMessage({
      content: [
        Prompt.toolApprovalResponsePart({
          approvalId,
          approved,
          ...(reason !== undefined ? { reason } : {}),
        }),
      ],
    }),
  )

  return Prompt.fromMessages(messages)
}

/** Max hop journaled for `turn` (−1 if none); the handler resumes at maxHopForTurn + 1. Only certain payloads carry a numeric hop, so narrow on `_tag`. */
export const maxHopForTurn = (
  events: ReadonlyArray<ReconstructEvent>,
  turn: number,
): number => {
  let max = -1
  for (const { event } of events) {
    switch (event._tag) {
      case "assistant-text":
      case "tool-call":
      case "tool-result":
      case "approval-requested":
      case "hop-messages":
      case "usage":
        if (event.turn === turn && event.hop > max) max = event.hop
        break
      default:
        break
    }
  }
  return max
}
