#!/usr/bin/env bun
// CLI wrapper around the deployed Worker's agent endpoints. The work is one
// Effect over the typed AgentApi client; argv/exit code is the process edge.
// Usage:
//   bun run agent <name> <id> --message "hi" [--url URL] [--model M] [--skill S] [--role R]
//   bun run agent <name> <id> --journal [--url URL]
//   bun run agent --sessions [--url URL]

import type { JournalEvent } from "../packages/shared/src/index.ts"
import { makePromptRequest } from "../packages/shared/src/index.ts"
import { Cause, Console, Effect, Exit } from "effect"
import { ApiClient, fetchAllEvents, makeRuntime, parseArgs, resolveBaseUrl } from "./lib.ts"

const USAGE = [
  'Usage: bun run agent <name> <id> --message "text" [--url URL] [--model M] [--skill S] [--role R]',
  "       bun run agent <name> <id> --journal [--url URL]",
  "       bun run agent --sessions [--url URL]",
].join("\n")

const truncate = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max)}…` : value

const formatEvent = ({ createdAt, event, seq }: JournalEvent): string => {
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
    case "hop-messages":
      return `${head}  turn=${event.turn} hop=${event.hop}  ${event.messages.length} prompt message(s): ${event.messages.map((m) => m.role).join(", ")}`
    case "usage":
      return `${head}  turn=${event.turn} hop=${event.hop}  model=${event.model}  in=${event.inputTokens ?? "?"} out=${event.outputTokens ?? "?"} total=${event.totalTokens ?? "?"}${event.cost !== undefined ? `  cost=$${event.cost}` : ""}`
    case "done":
      return `${head}  turn=${event.turn}  ${event.finishReason}  toolCalls=${event.toolCallCount}`
    case "error":
      return `${head}  turn=${event.turn}  ${truncate(event.message, 200)}`
  }
}

const parsed = parseArgs(process.argv.slice(2), new Set(["journal", "sessions"]))
if ("error" in parsed) {
  console.error(parsed.error)
  console.error(USAGE)
  process.exit(1)
}
const base = resolveBaseUrl(parsed.flags["url"])
if (base === undefined) {
  console.error("BASE_URL or --url required")
  console.error(USAGE)
  process.exit(1)
}
const runtime = makeRuntime(base)

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

const result = await runtime.runPromiseExit(main)
await runtime.dispose()
if (Exit.isFailure(result)) {
  const failReason = result.cause.reasons.find(Cause.isFailReason)
  console.error(
    failReason !== undefined
      ? (failReason.error instanceof Error ? failReason.error.message : String(failReason.error))
      : Cause.pretty(result.cause),
  )
}
process.exitCode = Exit.isSuccess(result) ? 0 : 1
