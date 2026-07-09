import type { JournalEventPayload } from "@effect-flue/shared"
import { Prompt } from "effect/unstable/ai"

/**
 * Pure prompt reconstruction for approve-and-continue (#40).
 *
 * A PARKED turn is one whose model loop stopped mid-hop awaiting a tool
 * approval. To resume it, the `approve` handler decodes the whole journal into
 * {@link ReconstructEvent}s and calls {@link reconstructForContinuation} to
 * rebuild the exact continuation prompt — no I/O here: skill/role bodies are
 * passed in.
 *
 * The rebuilt message array is, in order:
 *   1. system message(s): skill body, then role body (if any);
 *   2. every prior (non-parked) turn as TEXT ONLY — its user message followed
 *      by one assistant message joining that turn's `assistant-text` events.
 *      Prior turns' hop-messages/tool artifacts are deliberately omitted: they
 *      would leak stray approval parts the provider rejects;
 *   3. the parked turn: its user message, then its `hop-messages` in ascending
 *      hop order, with ALREADY-RESOLVED `tool-approval-request` parts filtered
 *      out (see below) so only the current approval's request remains open;
 *   4. the approval response as a trailing `tool` message.
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

  // Group/order deterministically by seq — concurrent prompts to one session
  // interleave appends, so never trust input order.
  const bySeq = [...events].sort((a, b) => a.seq - b.seq)

  const messages: Array<Prompt.Message> = []

  // 1. System messages (skill, then role).
  messages.push(Prompt.systemMessage({ content: skillBody }))
  if (roleBody !== undefined) {
    messages.push(Prompt.systemMessage({ content: roleBody }))
  }

  // 2. Prior turns — TEXT ONLY (user message + one joined assistant message).
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

  // 3a. Parked turn's user message.
  for (const { event, seq } of bySeq) {
    if (seq === parkedTurn && event._tag === "user-message") {
      messages.push(Prompt.userMessage({ content: [Prompt.textPart({ text: event.content })] }))
      break
    }
  }

  // 3b. Set of toolCallIds already resolved (have a tool-result) in this turn.
  // An earlier approval in the same parked turn may have been approved and
  // continued: its `tool-approval-request` still sits in the hop-messages but
  // its response was stripped (never journaled). An orphaned request (no
  // matching response) makes the provider reject the prompt, so drop it. The
  // CURRENT approval's request has no tool-result yet, so it survives the
  // filter and stays open for the trailing approval response.
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

  // 3c. Parked turn's hop-messages, ascending hop order, filtered.
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
        // Nothing dropped — keep the original (preserves provider options).
        messages.push(message)
      } else if (filtered.length > 0) {
        messages.push(Prompt.assistantMessage({ content: filtered }))
      }
      // else: filtering emptied the message — drop it.
    }
  }

  // 4. Approval response (last message).
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

/**
 * Max hop number journaled for `turn` (−1 if none). The handler sets
 * `startHop = maxHopForTurn + 1` so the continuation resumes past every hop
 * already recorded for the parked turn. Only certain payloads carry a numeric
 * `hop`, so narrow on `_tag` before reading it.
 */
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
