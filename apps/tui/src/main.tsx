#!/usr/bin/env bun
import { render } from "ink"
import { App } from "./App.tsx"
import { parseCliConfig } from "./cli.ts"
import type { PromptOverrides } from "./client.ts"
import { makeAgentClient } from "./client.ts"

const config = parseCliConfig(process.argv.slice(2))
const client = await makeAgentClient(config.baseUrl)

const overrides: PromptOverrides = {
  ...(config.model !== undefined ? { model: config.model } : {}),
  ...(config.skill !== undefined ? { skill: config.skill } : {}),
  ...(config.role !== undefined ? { role: config.role } : {}),
}

if (config.message !== undefined) {
  // One-shot mode: stream a single turn to stdout without mounting Ink —
  // safe under non-TTY stdin, and the autonomous smoke path.
  let sawDone = false
  let exitCode = 0
  try {
    for await (const part of client.streamPrompt(config.name, config.id, config.message, overrides)) {
      switch (part._tag) {
        case "text-delta":
          process.stdout.write(part.delta)
          break
        case "tool-call":
          process.stdout.write(`\n[tool-call ${part.name} ${JSON.stringify(part.params) ?? ""}]\n`)
          break
        case "tool-result":
          process.stdout.write(
            `[tool-result${part.isFailure ? " FAILED" : ""} ${JSON.stringify(part.result) ?? ""}]\n`,
          )
          break
        case "done":
          sawDone = true
          process.stdout.write(`\n[done ${part.finishReason}, ${part.toolCallCount} tool call(s)]\n`)
          break
        case "error":
          exitCode = 1
          console.error(`\n[error] ${part.message}`)
          break
      }
    }
  } catch (error) {
    console.error(`\n[stream failed] ${error instanceof Error ? error.message : String(error)}`)
    exitCode = 1
  }
  if (!sawDone) {
    // A stream that ends without a `done` part (network drop, worker
    // timeout) must not pass as a successful smoke.
    exitCode = 1
  }
  process.exit(exitCode)
}

render(<App client={client} name={config.name} id={config.id} initialOverrides={overrides} />)
