#!/usr/bin/env bun
import type { StreamPart } from "@effect-flue/shared"
import { Cause, Effect, Exit, Stream } from "effect"
import { render } from "ink"
import { App } from "./App.tsx"
import { parseCliConfig } from "./cli.ts"
import type { PromptOverrides } from "./client.ts"
import { makeAgentClient } from "./client.ts"

const config = parseCliConfig(process.argv.slice(2))
const client = makeAgentClient(config.baseUrl)

const overrides: PromptOverrides = {
  ...(config.model !== undefined ? { model: config.model } : {}),
  ...(config.skill !== undefined ? { skill: config.skill } : {}),
  ...(config.role !== undefined ? { role: config.role } : {}),
}

if (config.message !== undefined) {
  // One-shot mode: stream a single turn to stdout without mounting Ink — safe
  // under non-TTY stdin, and the autonomous smoke path. The turn runs through
  // the client runtime as an Effect stream; the process edge (stdout, exit
  // code) is the boundary.
  let sawDone = false
  let exitCode = 0
  const onPart = (part: StreamPart) => {
    switch (part._tag) {
      case "text-delta":
        process.stdout.write(part.delta)
        return
      case "tool-call":
        process.stdout.write(`\n[tool-call ${part.name} ${JSON.stringify(part.params) ?? ""}]\n`)
        return
      case "tool-result":
        process.stdout.write(
          `[tool-result${part.isFailure ? " FAILED" : ""} ${JSON.stringify(part.result) ?? ""}]\n`,
        )
        return
      case "done":
        sawDone = true
        process.stdout.write(`\n[done ${part.finishReason}, ${part.toolCallCount} tool call(s)]\n`)
        return
      case "error":
        exitCode = 1
        console.error(`\n[error] ${part.message}`)
        return
    }
  }
  const result = await client.runtime.runPromiseExit(
    Stream.runForEach(
      client.streamPrompt(config.name, config.id, config.message, overrides),
      (part) => Effect.sync(() => onPart(part)),
    ),
  )
  await client.runtime.dispose()
  if (Exit.isFailure(result)) {
    const failReason = result.cause.reasons.find(Cause.isFailReason)
    const message = failReason === undefined
      ? "unknown error"
      : failReason.error instanceof Error
      ? failReason.error.message
      : String(failReason.error)
    console.error(`\n[stream failed] ${message}`)
    exitCode = 1
  }
  // A stream that ends without a `done` part (network drop, worker timeout)
  // must not pass as a successful smoke.
  if (!sawDone) exitCode = 1
  process.exit(exitCode)
}

render(<App client={client} name={config.name} id={config.id} initialOverrides={overrides} />)
