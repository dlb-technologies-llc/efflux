import { COMPACTION_SUMMARY_PREFIX, type JournalEventPayload } from "@efflux/shared"
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
 * approval `approvalId` with the given decision. Message order:
 * `[skill, role?, memory?, todos?, compaction-summary?, prior turns, parked turn, tool-approval-response]`.
 */
export const reconstructForContinuation = (input: {
  events: ReadonlyArray<ReconstructEvent>
  parkedTurn: number
  approvalId: string
  approved: boolean
  reason?: string
  skillBody: string
  roleBody: string | undefined
  memory?: string
  todos?: string
}): Prompt.Prompt => {
  const { approvalId, approved, events, memory, parkedTurn, reason, roleBody, skillBody, todos } = input

  const bySeq = [...events].sort((a, b) => a.seq - b.seq)

  let compThrough = -1
  let compSummary: string | undefined
  for (const { event } of bySeq) {
    if (event._tag === "compaction" && event.throughSeq < parkedTurn) {
      compThrough = event.throughSeq
      compSummary = event.summary
    }
  }

  const priorUsers: Array<{ seq: number; content: string }> = []
  const textsByTurn = new Map<number, Array<string>>()
  const resolvedToolCallIds = new Set<string>()
  const parkedHops: Array<{ hop: number; messages: ReadonlyArray<Prompt.Message> }> = []
  let parkedUserContent: string | undefined

  for (const { event, seq } of bySeq) {
    switch (event._tag) {
      case "user-message": {
        if (seq < parkedTurn && seq > compThrough) {
          priorUsers.push({ seq, content: event.content })
        } else if (seq === parkedTurn) {
          parkedUserContent = event.content
        }
        break
      }
      case "assistant-text": {
        const texts = textsByTurn.get(event.turn)
        if (texts === undefined) {
          textsByTurn.set(event.turn, [event.text])
        } else {
          texts.push(event.text)
        }
        break
      }
      case "tool-result": {
        if (event.turn === parkedTurn) resolvedToolCallIds.add(event.part.id)
        break
      }
      case "hop-messages": {
        if (event.turn === parkedTurn) {
          for (const message of event.messages) {
            if (message.role === "tool") {
              for (const part of message.content) {
                if (part.type === "tool-result") resolvedToolCallIds.add(part.id)
              }
            }
          }
          parkedHops.push({ hop: event.hop, messages: event.messages })
        }
        break
      }
      default:
        break
    }
  }

  parkedHops.sort((a, b) => a.hop - b.hop)

  const messages: Array<Prompt.Message> = []

  messages.push(Prompt.systemMessage({ content: skillBody }))
  if (roleBody !== undefined) {
    messages.push(Prompt.systemMessage({ content: roleBody }))
  }

  if (memory !== undefined) {
    messages.push(Prompt.systemMessage({ content: memory }))
  }
  if (todos !== undefined) {
    messages.push(Prompt.systemMessage({ content: `Current task list:\n${todos}` }))
  }
  if (compSummary !== undefined) {
    messages.push(Prompt.userMessage({ content: [Prompt.textPart({ text: COMPACTION_SUMMARY_PREFIX + compSummary })] }))
  }

  for (const priorUser of priorUsers) {
    messages.push(Prompt.userMessage({ content: [Prompt.textPart({ text: priorUser.content })] }))
    const texts = textsByTurn.get(priorUser.seq)
    if (texts !== undefined && texts.length > 0) {
      messages.push(Prompt.assistantMessage({ content: [Prompt.textPart({ text: texts.join("") })] }))
    }
  }

  if (parkedUserContent !== undefined) {
    messages.push(Prompt.userMessage({ content: [Prompt.textPart({ text: parkedUserContent })] }))
  }

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
