#!/usr/bin/env bun
/** CLI wrapper around the deployed Worker's agent endpoints, over the typed AgentApi client. */

import type { JournalEvent } from "../packages/shared/src/index.ts"
import { makePromptRequest } from "../packages/shared/src/index.ts"
import { Console, Effect } from "effect"
import { ApiClient, bootstrap, fetchAllEvents, runMain } from "./lib.ts"

const USAGE = [
  'Usage: bun run agent <name> <id> --message "text" [--url URL] [--model M] [--skill S] [--role R]',
  "       bun run agent <name> <id> --journal [--url URL]",
  "       bun run agent --sessions [--url URL]",
].join("\n")

const truncate = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max)}…` : value

/** Render one journal event as a single dense log line for the `--journal` view. */
export const formatEvent = ({ createdAt, event, seq }: JournalEvent): string => {
  const head = `#${seq}  ${new Date(createdAt).toISOString()}  ${event._tag}`
  switch (event._tag) {
    case "user-message":
      return `${head}  ${truncate(JSON.stringify(event.content), 100)}${event.skill !== undefined ? `  skill=${event.skill}` : ""}${event.model !== undefined ? `  model=${event.model}` : ""}`
    case "assistant-text":
      return `${head}  turn=${event.turn} hop=${event.hop}  ${truncate(JSON.stringify(event.text), 100)}`
    case "tool-call":
      return `${head}  turn=${event.turn} hop=${event.hop}  ${event.part.name}(${truncate(JSON.stringify(event.part.params), 80)})  callId=${event.part.id}`
    case "tool-result":
      return `${head}  turn=${event.turn} hop=${event.hop}  ${event.part.name} ${event.part.isFailure ? "FAILED" : "ok"}  callId=${event.part.id}`
    case "approval-requested":
      return `${head}  turn=${event.turn} hop=${event.hop}  approvalId=${event.approvalId} callId=${event.toolCallId}`
    case "approval-resolved":
      return `${head}  turn=${event.turn}  ${event.approved ? "APPROVED" : "DENIED"} approvalId=${event.approvalId}${event.reason !== undefined ? `  ${truncate(event.reason, 100)}` : ""}`
    case "hop-messages":
      return `${head}  turn=${event.turn} hop=${event.hop}  ${event.messages.length} prompt message(s): ${event.messages.map((m) => m.role).join(", ")}`
    case "usage":
      return `${head}  turn=${event.turn} hop=${event.hop}  model=${event.model}  in=${event.inputTokens ?? "?"} out=${event.outputTokens ?? "?"} total=${event.totalTokens ?? "?"}${event.cost !== undefined ? `  cost=$${event.cost}` : ""}`
    case "done":
      return `${head}  turn=${event.turn}  ${event.finishReason}  toolCalls=${event.toolCallCount}`
    case "error":
      return `${head}  turn=${event.turn}  ${truncate(event.message, 200)}`
    case "session-closed":
      return `${head}  reason=${event.reason}`
  }
}

/** CLI entry — skipped when imported (e.g. by tests). */
if (import.meta.main) {
  const { parsed, runtime } = bootstrap(process.argv.slice(2), new Set(["journal", "sessions"]), USAGE)

  const main = Effect.gen(function*() {
    const api = yield* ApiClient

    if (parsed.flags["sessions"] === "true") {
      const response = yield* api.agents.sessions()
      if (response.sessions.length === 0) yield* Console.log("(no sessions)")
      yield* Effect.forEach(response.sessions, (session) =>
        Console.log(
          `${session.name}/${session.id}  created ${new Date(session.createdAt).toISOString()}  active ${
            new Date(session.lastActiveAt).toISOString()
          }`,
        ))
      return
    }

    const name = parsed.positional[0]
    const id = parsed.positional[1]

    if (parsed.flags["journal"] === "true") {
      if (name === undefined || id === undefined) return yield* Effect.fail(new Error(USAGE))
      const events = yield* fetchAllEvents(api, name, id)
      yield* Effect.forEach(events, (event) => Console.log(formatEvent(event)))
      yield* Console.log(`(${events.length} events)`)
      return
    }

    const message = parsed.flags["message"]
    if (name === undefined || id === undefined || message === undefined) {
      return yield* Effect.fail(new Error(USAGE))
    }
    const overrides = {
      ...(parsed.flags["model"] !== undefined ? { model: parsed.flags["model"] } : {}),
      ...(parsed.flags["skill"] !== undefined ? { skill: parsed.flags["skill"] } : {}),
      ...(parsed.flags["role"] !== undefined ? { role: parsed.flags["role"] } : {}),
    }
    const response = yield* api.agents.prompt({
      params: { name, id },
      payload: makePromptRequest(message, overrides),
    })
    yield* Console.log(response.text)
  })

  await runMain(main, runtime)
}
