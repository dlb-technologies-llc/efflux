#!/usr/bin/env bun
import { failureMessage } from "@efflux/shared"
import type { StreamPart } from "@efflux/shared"
import { Effect, Exit, Function, Stream } from "effect"
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
      case "approval-request":
        process.stderr.write(`\n[approval-request ${part.toolCallId} — parked; approve interactively]\n`)
        return
      default:
        return Function.absurd(part)
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
    console.error(`\n[stream failed] ${failureMessage(result.cause, "unknown error")}`)
    exitCode = 1
  }
  if (!sawDone) exitCode = 1
  process.exit(exitCode)
}

render(<App client={client} name={config.name} id={config.id} initialOverrides={overrides} />)
