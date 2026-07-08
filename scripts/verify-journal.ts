#!/usr/bin/env bun
// Executable proof of the event journal's hard criterion: a session's
// journal must be PROMPT-RECONSTRUCTIBLE — the parked-turn prompt rebuilds
// from journal events through the real `effect/unstable/ai` Prompt schemas,
// not display-shaped stream parts.
//
// Checks, per (turn, hop):
//   a. every `tool-call` has a matching `tool-result` (same call id) —
//      a dangling call is a parked/incomplete turn: fatal unless
//      --allow-parked;
//   b. every granular tool-call/tool-result part also appears (by call id)
//      inside that hop's authoritative `hop-messages` event — the two
//      journal layers must agree;
//   c. the hop's messages survive a Prompt.Message encode→decode→encode
//      round-trip byte-for-byte;
// and globally: the rebuilt prompt (user messages + hop messages in seq
// order) is non-empty for any session that has a user-message event.
//
// Usage: bun scripts/verify-journal.ts <name> <id> [--url URL] [--allow-parked]
export {}

import { Effect, Schema } from "effect"
import { Prompt } from "effect/unstable/ai"
import { JournalResponse } from "../packages/shared/src/Journal.ts"

const USAGE =
  "Usage: bun scripts/verify-journal.ts <name> <id> [--url URL] [--allow-parked]"

const argv = process.argv.slice(2)
const positional: string[] = []
const flags: Record<string, string> = {}
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === undefined) continue
  if (arg === "--allow-parked") {
    flags["allow-parked"] = "true"
  } else if (arg.startsWith("--")) {
    const value = argv[i + 1]
    if (value === undefined) {
      console.error(USAGE)
      process.exit(1)
    }
    flags[arg.slice(2)] = value
    i++
  } else {
    positional.push(arg)
  }
}

const agentName = positional[0]
const id = positional[1]
const baseUrl = flags["url"] ?? process.env["BASE_URL"]
if (agentName === undefined || id === undefined) {
  console.error(USAGE)
  process.exit(1)
}
if (baseUrl === undefined || baseUrl === "") {
  console.error("BASE_URL or --url required")
  process.exit(1)
}
const base = baseUrl.replace(/\/$/, "")
const allowParked = flags["allow-parked"] === "true"

const decodeJournal = Schema.decodeUnknownEffect(JournalResponse)
const encodeMessage = Schema.encodeSync(Prompt.Message)
const decodeMessage = Schema.decodeUnknownSync(Prompt.Message)

// ---------------------------------------------------------------------------
// Fetch the full journal (following pagination)
// ---------------------------------------------------------------------------

const events: Array<(typeof JournalResponse.Type)["events"][number]> = []
{
  const path = `${base}/agents/${encodeURIComponent(agentName)}/${encodeURIComponent(id)}/journal`
  let after = 0
  for (;;) {
    const res = await fetch(`${path}?after=${after}`)
    const text = await res.text()
    if (!res.ok) {
      console.error(`FAIL journal fetch: HTTP ${res.status}\n${text}`)
      process.exit(1)
    }
    // The shared-schema decode IS check zero: every tool part in the
    // journal must decode through Prompt.ToolCallPart / Prompt.ToolResultPart.
    const page = await Effect.runPromise(decodeJournal(JSON.parse(text)))
    events.push(...page.events)
    if (page.nextAfter === null) break
    after = page.nextAfter
  }
}

if (events.length === 0) {
  console.error("FAIL: journal is empty — run a tool-calling session first")
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Group by (turn, hop) and verify
// ---------------------------------------------------------------------------

type HopData = {
  toolCallIds: Map<string, string> // call id → tool name
  toolResultIds: Set<string>
  messages: ReadonlyArray<Prompt.Message> | undefined
}
const turns = new Map<number, Map<number, HopData>>()
const userMessages: Array<{ seq: number; content: string }> = []

const hopData = (turn: number, hop: number): HopData => {
  let hops = turns.get(turn)
  if (hops === undefined) {
    hops = new Map()
    turns.set(turn, hops)
  }
  let data = hops.get(hop)
  if (data === undefined) {
    data = {
      toolCallIds: new Map(),
      toolResultIds: new Set(),
      messages: undefined,
    }
    hops.set(hop, data)
  }
  return data
}

for (const { seq, event } of events) {
  switch (event._tag) {
    case "user-message":
      userMessages.push({ seq, content: event.content })
      break
    case "tool-call":
      hopData(event.turn, event.hop).toolCallIds.set(
        event.part.id,
        event.part.name,
      )
      break
    case "tool-result":
      hopData(event.turn, event.hop).toolResultIds.add(event.part.id)
      break
    case "hop-messages":
      hopData(event.turn, event.hop).messages = event.messages
      break
    default:
      break
  }
}

const failures: Array<string> = []
const parked: Array<string> = []

for (const [turn, hops] of turns) {
  for (const [hop, data] of hops) {
    const where = `turn=${turn} hop=${hop}`

    // a. call/result pairing
    let hopHasDanglingCall = false
    for (const [callId, toolName] of data.toolCallIds) {
      if (!data.toolResultIds.has(callId)) {
        hopHasDanglingCall = true
        parked.push(
          `${where}: tool-call ${toolName} (${callId}) has no tool-result — parked/incomplete turn`,
        )
      }
    }

    // b. granular ↔ authoritative consistency
    if (data.toolCallIds.size > 0 || data.toolResultIds.size > 0) {
      if (data.messages === undefined) {
        // tool-call/tool-result are journaled inline, but hop-messages is
        // batched only at hop end — so a parked hop (one with a dangling
        // call) NECESSARILY lacks hop-messages. That absence is the
        // expected shape of a parked turn, not corruption: record it as
        // PARKED (suppressible by --allow-parked). Only a hop whose tool
        // calls ALL resolved is genuinely corrupt when hop-messages is
        // missing — that stays a fatal FAIL.
        if (hopHasDanglingCall) {
          parked.push(
            `${where}: no hop-messages event — parked hop (batched only at hop end)`,
          )
        } else {
          failures.push(
            `${where}: granular tool events exist but no hop-messages event`,
          )
        }
      } else {
        const inMessages = new Set<string>()
        for (const message of data.messages) {
          for (const part of message.content) {
            if (
              typeof part === "object" &&
              (part.type === "tool-call" || part.type === "tool-result")
            ) {
              inMessages.add(part.id)
            }
          }
        }
        for (const [callId, toolName] of data.toolCallIds) {
          if (!inMessages.has(callId)) {
            failures.push(
              `${where}: tool-call ${toolName} (${callId}) missing from hop-messages`,
            )
          }
        }
        for (const callId of data.toolResultIds) {
          if (!inMessages.has(callId)) {
            failures.push(
              `${where}: tool-result (${callId}) missing from hop-messages`,
            )
          }
        }
      }
    }

    // c. Prompt.Message round-trip
    if (data.messages !== undefined) {
      for (const message of data.messages) {
        try {
          const encoded = encodeMessage(message)
          const reEncoded = encodeMessage(decodeMessage(encoded))
          if (JSON.stringify(encoded) !== JSON.stringify(reEncoded)) {
            failures.push(
              `${where}: ${message.role} message does not round-trip through Prompt.Message\n  first:  ${JSON.stringify(encoded)}\n  second: ${JSON.stringify(reEncoded)}`,
            )
          }
        } catch (error) {
          failures.push(
            `${where}: ${message.role} message failed Prompt.Message encode/decode: ${String(error)}`,
          )
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Rebuild the full prompt: user + hop messages in seq order
// ---------------------------------------------------------------------------

const rebuilt: Array<Prompt.Message> = []
for (const user of userMessages) {
  rebuilt.push(
    Prompt.userMessage({
      content: [Prompt.textPart({ text: user.content })],
    }),
  )
  const hops = turns.get(user.seq)
  if (hops !== undefined) {
    for (const hop of [...hops.keys()].sort((a, b) => a - b)) {
      const messages = hops.get(hop)?.messages
      if (messages !== undefined) rebuilt.push(...messages)
    }
  }
}

if (userMessages.length > 0) {
  const prompt = Prompt.fromMessages(rebuilt)
  if (prompt.content.length === 0) {
    failures.push("rebuilt prompt is empty despite user-message events")
  }
} else {
  failures.push("no user-message events found — nothing to rebuild")
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

for (const note of parked) console.error(`PARKED  ${note}`)
for (const failure of failures) console.error(`FAIL    ${failure}`)

const parkedFatal = parked.length > 0 && !allowParked
if (failures.length > 0 || parkedFatal) {
  if (parkedFatal) {
    console.error(
      "(dangling tool calls are fatal without --allow-parked)",
    )
  }
  process.exit(1)
}

console.log(
  `OK: ${events.length} events, ${userMessages.length} turn(s), ${[...turns.values()].reduce((n, hops) => n + hops.size, 0)} hop group(s) — prompt rebuilds through effect/unstable/ai Prompt schemas (${rebuilt.length} messages)`,
)
