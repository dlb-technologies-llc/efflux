#!/usr/bin/env bun
// Executable proof of the event journal's hard criterion: a session's journal
// must be PROMPT-RECONSTRUCTIBLE — the parked-turn prompt rebuilds from journal
// events through the real `effect/unstable/ai` Prompt schemas, not
// display-shaped stream parts.
//
// Checks, per (turn, hop):
//   a. every `tool-call` has a matching `tool-result` (same call id) — a
//      dangling call is a parked/incomplete turn: fatal unless --allow-parked;
//   b. every granular tool-call/tool-result part also appears (by call id)
//      inside that hop's authoritative `hop-messages` event;
//   c. the hop's messages survive a Prompt.Message encode→decode→encode
//      round-trip byte-for-byte;
// and globally: the rebuilt prompt is non-empty for any session with a
// user-message event.
//
// The fetch + entrypoint are Effect (typed AgentApi client); the verification
// is pure computation over the decoded events. argv/exit is the process edge.
//
// Usage: bun scripts/verify-journal.ts <name> <id> [--url URL] [--allow-parked]

import type { JournalEvent } from "../packages/shared/src/index.ts"
import { Cause, Console, Effect, Exit, Schema } from "effect"
import { Prompt } from "effect/unstable/ai"
import { ApiClient, fetchAllEvents, makeRuntime, parseArgs, resolveBaseUrl } from "./lib.ts"

const USAGE = "Usage: bun scripts/verify-journal.ts <name> <id> [--url URL] [--allow-parked]"

const encodeMessage = Schema.encodeSync(Prompt.Message)
const decodeMessage = Schema.decodeUnknownSync(Prompt.Message)

interface HopData {
  readonly toolCallIds: Map<string, string>
  readonly toolResultIds: Set<string>
  messages: ReadonlyArray<Prompt.Message> | undefined
}

interface VerifyResult {
  readonly failures: ReadonlyArray<string>
  readonly parked: ReadonlyArray<string>
  readonly turnCount: number
  readonly hopGroups: number
  readonly rebuiltCount: number
}

// Pure: group events by (turn, hop), run checks a/b/c, rebuild the prompt.
const verify = (events: ReadonlyArray<JournalEvent>): VerifyResult => {
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
      data = { toolCallIds: new Map(), toolResultIds: new Set(), messages: undefined }
      hops.set(hop, data)
    }
    return data
  }

  for (const { event, seq } of events) {
    switch (event._tag) {
      case "user-message":
        userMessages.push({ seq, content: event.content })
        break
      case "tool-call":
        hopData(event.turn, event.hop).toolCallIds.set(event.part.id, event.part.name)
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
          parked.push(`${where}: tool-call ${toolName} (${callId}) has no tool-result — parked/incomplete turn`)
        }
      }

      // b. granular ↔ authoritative consistency
      if (data.toolCallIds.size > 0 || data.toolResultIds.size > 0) {
        if (data.messages === undefined) {
          // A parked hop (one with a dangling call) necessarily lacks the
          // hop-end-batched hop-messages — expected, record as PARKED. A hop
          // whose calls ALL resolved but lacks hop-messages is corrupt: FAIL.
          if (hopHasDanglingCall) {
            parked.push(`${where}: no hop-messages event — parked hop (batched only at hop end)`)
          } else {
            failures.push(`${where}: granular tool events exist but no hop-messages event`)
          }
        } else {
          const inMessages = new Set<string>()
          for (const message of data.messages) {
            for (const part of message.content) {
              if (typeof part === "object" && (part.type === "tool-call" || part.type === "tool-result")) {
                inMessages.add(part.id)
              }
            }
          }
          for (const [callId, toolName] of data.toolCallIds) {
            if (!inMessages.has(callId)) {
              failures.push(`${where}: tool-call ${toolName} (${callId}) missing from hop-messages`)
            }
          }
          for (const callId of data.toolResultIds) {
            if (!inMessages.has(callId)) {
              failures.push(`${where}: tool-result (${callId}) missing from hop-messages`)
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
                `${where}: ${message.role} message does not round-trip through Prompt.Message\n  first:  ${
                  JSON.stringify(encoded)
                }\n  second: ${JSON.stringify(reEncoded)}`,
              )
            }
          } catch (error) {
            failures.push(`${where}: ${message.role} message failed Prompt.Message encode/decode: ${String(error)}`)
          }
        }
      }
    }
  }

  // Rebuild the full prompt: user + hop messages in seq order.
  const rebuilt: Array<Prompt.Message> = []
  for (const user of userMessages) {
    rebuilt.push(Prompt.userMessage({ content: [Prompt.textPart({ text: user.content })] }))
    const hops = turns.get(user.seq)
    if (hops !== undefined) {
      for (const hop of [...hops.keys()].sort((a, b) => a - b)) {
        const messages = hops.get(hop)?.messages
        if (messages !== undefined) rebuilt.push(...messages)
      }
    }
  }
  if (userMessages.length > 0) {
    if (Prompt.fromMessages(rebuilt).content.length === 0) {
      failures.push("rebuilt prompt is empty despite user-message events")
    }
  } else {
    failures.push("no user-message events found — nothing to rebuild")
  }

  return {
    failures,
    parked,
    turnCount: userMessages.length,
    hopGroups: [...turns.values()].reduce((n, hops) => n + hops.size, 0),
    rebuiltCount: rebuilt.length,
  }
}

// --- process boundary: parse args, then run the Effect ---
const parsed = parseArgs(process.argv.slice(2), new Set(["allow-parked"]))
if ("error" in parsed) {
  console.error(parsed.error)
  console.error(USAGE)
  process.exit(1)
}
const name = parsed.positional[0]
const id = parsed.positional[1]
const base = resolveBaseUrl(parsed.flags["url"])
if (name === undefined || id === undefined || base === undefined) {
  console.error(USAGE)
  process.exit(1)
}
const allowParked = parsed.flags["allow-parked"] === "true"
const runtime = makeRuntime(base)

const main = Effect.gen(function*() {
  const api = yield* ApiClient
  const events = yield* fetchAllEvents(api, name, id)
  if (events.length === 0) {
    yield* Console.error("FAIL: journal is empty — run a tool-calling session first")
    return false
  }
  const result = verify(events)
  yield* Effect.forEach(result.parked, (note) => Console.error(`PARKED  ${note}`))
  yield* Effect.forEach(result.failures, (failure) => Console.error(`FAIL    ${failure}`))
  const parkedFatal = result.parked.length > 0 && !allowParked
  if (result.failures.length > 0 || parkedFatal) {
    if (parkedFatal) yield* Console.error("(dangling tool calls are fatal without --allow-parked)")
    return false
  }
  yield* Console.log(
    `OK: ${events.length} events, ${result.turnCount} turn(s), ${result.hopGroups} hop group(s) — prompt rebuilds through effect/unstable/ai Prompt schemas (${result.rebuiltCount} messages)`,
  )
  return true
})

const outcome = await runtime.runPromiseExit(main)
await runtime.dispose()
let exitCode = 1
if (Exit.isSuccess(outcome)) {
  exitCode = outcome.value ? 0 : 1
} else {
  const failReason = outcome.cause.reasons.find(Cause.isFailReason)
  console.error(
    failReason !== undefined
      ? `FAIL journal fetch: ${failReason.error instanceof Error ? failReason.error.message : String(failReason.error)}`
      : Cause.pretty(outcome.cause),
  )
}
process.exitCode = exitCode
