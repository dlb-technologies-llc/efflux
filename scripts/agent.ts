#!/usr/bin/env bun
// CLI wrapper around the deployed Worker's agent endpoints.
// Usage:
//   bun run agent <name> <id> --message "hi" [--url URL] [--model M] [--skill S] [--role R]
//   bun run agent <name> <id> --journal [--url URL]
//   bun run agent --sessions [--url URL]
export {}

import { Effect, Schema } from "effect"
import { JournalResponse, SessionsResponse } from "../packages/shared/src/Journal.ts"

const USAGE = [
  'Usage: bun run agent <name> <id> --message "text" [--url URL] [--model M] [--skill S] [--role R]',
  "       bun run agent <name> <id> --journal [--url URL]",
  "       bun run agent --sessions [--url URL]",
].join("\n")

// Flags that take no value.
const BOOLEAN_FLAGS = new Set(["journal", "sessions"])

const argv = process.argv.slice(2)
const positional: string[] = []
const flags: Record<string, string> = {}

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === undefined) continue
  if (arg.startsWith("--")) {
    const key = arg.slice(2)
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = "true"
      continue
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith("--")) {
      console.error(`Missing value for --${key}`)
      console.error(USAGE)
      process.exit(1)
    }
    flags[key] = value
    i++
  } else {
    positional.push(arg)
  }
}

const baseUrl = flags["url"] ?? process.env["BASE_URL"]
if (baseUrl === undefined || baseUrl === "") {
  console.error("BASE_URL or --url required")
  process.exit(1)
}
const base = baseUrl.replace(/\/$/, "")

const fetchJson = async (url: string): Promise<unknown> => {
  const res = await fetch(url)
  const text = await res.text()
  if (!res.ok) {
    console.error(`HTTP ${res.status} ${res.statusText}`)
    console.error(text)
    process.exit(1)
  }
  return JSON.parse(text)
}

const truncate = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max)}…` : value

// ---------------------------------------------------------------------------
// --sessions: list the session registry (GET /agents)
// ---------------------------------------------------------------------------

if (flags["sessions"] === "true") {
  const decoded = await Effect.runPromise(
    Schema.decodeUnknownEffect(SessionsResponse)(
      await fetchJson(`${base}/agents`),
    ),
  )
  if (decoded.sessions.length === 0) {
    console.log("(no sessions)")
  }
  for (const session of decoded.sessions) {
    console.log(
      `${session.name}/${session.id}  created ${new Date(session.createdAt).toISOString()}  active ${new Date(session.lastActiveAt).toISOString()}`,
    )
  }
  process.exit(0)
}

const agentName = positional[0]
const id = positional[1]

// ---------------------------------------------------------------------------
// --journal: paginated typed event dump (GET /agents/:name/:id/journal)
// ---------------------------------------------------------------------------

if (flags["journal"] === "true") {
  if (agentName === undefined || id === undefined) {
    console.error(USAGE)
    process.exit(1)
  }
  const decodeJournal = Schema.decodeUnknownEffect(JournalResponse)
  const sessionPath = `${base}/agents/${encodeURIComponent(agentName)}/${encodeURIComponent(id)}/journal`
  let after = 0
  let total = 0
  for (;;) {
    const page = await Effect.runPromise(
      decodeJournal(await fetchJson(`${sessionPath}?after=${after}`)),
    )
    for (const { seq, createdAt, event } of page.events) {
      total++
      const stamp = new Date(createdAt).toISOString()
      const head = `#${seq}  ${stamp}  ${event._tag}`
      switch (event._tag) {
        case "user-message":
          console.log(
            `${head}  ${truncate(JSON.stringify(event.content), 100)}${event.skill !== undefined ? `  skill=${event.skill}` : ""}${event.model !== undefined ? `  model=${event.model}` : ""}`,
          )
          break
        case "assistant-text":
          console.log(
            `${head}  turn=${event.turn} hop=${event.hop}  ${truncate(JSON.stringify(event.text), 100)}`,
          )
          break
        case "tool-call":
          console.log(
            `${head}  turn=${event.turn} hop=${event.hop}  ${event.part.name}(${truncate(JSON.stringify(event.part.params), 80)})  callId=${event.part.id}`,
          )
          break
        case "tool-result":
          console.log(
            `${head}  turn=${event.turn} hop=${event.hop}  ${event.part.name} ${event.part.isFailure ? "FAILED" : "ok"}  callId=${event.part.id}`,
          )
          break
        case "hop-messages":
          console.log(
            `${head}  turn=${event.turn} hop=${event.hop}  ${event.messages.length} prompt message(s): ${event.messages.map((m) => m.role).join(", ")}`,
          )
          break
        case "usage":
          console.log(
            `${head}  turn=${event.turn} hop=${event.hop}  model=${event.model}  in=${event.inputTokens ?? "?"} out=${event.outputTokens ?? "?"} total=${event.totalTokens ?? "?"}${event.cost !== undefined ? `  cost=$${event.cost}` : ""}`,
          )
          break
        case "done":
          console.log(
            `${head}  turn=${event.turn}  ${event.finishReason}  toolCalls=${event.toolCallCount}`,
          )
          break
        case "error":
          console.log(
            `${head}  turn=${event.turn}  ${truncate(event.message, 200)}`,
          )
          break
      }
    }
    if (page.nextAfter === null) break
    after = page.nextAfter
  }
  console.log(`(${total} events)`)
  process.exit(0)
}

// ---------------------------------------------------------------------------
// default: send one prompt (POST /agents/:name/:id)
// ---------------------------------------------------------------------------

const message = flags["message"]

if (agentName === undefined || id === undefined || message === undefined) {
  console.error(USAGE)
  process.exit(1)
}

const body: Record<string, string> = { message }
if (flags["model"] !== undefined) body["model"] = flags["model"]
if (flags["skill"] !== undefined) body["skill"] = flags["skill"]
if (flags["role"] !== undefined) body["role"] = flags["role"]

const url = `${base}/agents/${encodeURIComponent(agentName)}/${encodeURIComponent(id)}`

const res = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

const text = await res.text()

if (!res.ok) {
  console.error(`HTTP ${res.status} ${res.statusText}`)
  console.error(text)
  process.exit(1)
}

try {
  const parsed: unknown = JSON.parse(text)
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "text" in parsed &&
    typeof parsed.text === "string"
  ) {
    console.log(parsed.text)
  } else {
    console.log(text)
  }
} catch {
  console.log(text)
}
