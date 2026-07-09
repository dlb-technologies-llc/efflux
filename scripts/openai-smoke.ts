#!/usr/bin/env bun
/** Stock `openai` SDK smoke: drives a tool-using conversation through the `/v1` facade to prove any OpenAI client can treat an effect-flue session as a model. */

import { Cause, Console, Effect, Exit } from "effect"
import OpenAI from "openai"
import { ApiClient, makeRuntime, parseArgs, resolveBaseUrl } from "./lib.ts"

const USAGE = "Usage: bun run openai-smoke <name> <id> [--url URL]"

const parsed = parseArgs(process.argv.slice(2), new Set())
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

const name = parsed.positional[0]
const id = parsed.positional[1]
if (name === undefined || id === undefined) {
  console.error(USAGE)
  process.exit(1)
}

const runtime = makeRuntime(base)
const model = `agent:${name}:${id}`

const main = Effect.gen(function*() {
  const api = yield* ApiClient

  yield* api.agents.putConfig({
    params: { name, id },
    payload: { defaultModel: "openai/gpt-4o-mini", rules: { Bash: "allow" } },
  })
  yield* Console.log(`configured session ${model} → openai/gpt-4o-mini, Bash:allow`)

  const openai = new OpenAI({ baseURL: `${base}/v1`, apiKey: process.env["OPENAI_API_KEY"] ?? "unused" })

  const firstUser = "Use bash to run `uname -a`, then tell me the kernel release string."
  const first = yield* Effect.promise(() =>
    openai.chat.completions.create({ model, messages: [{ role: "user", content: firstUser }] })
  )
  const firstReply = first.choices[0]?.message?.content ?? ""
  yield* Console.log(`non-stream reply: ${firstReply}`)
  yield* Console.log(`non-stream usage: ${JSON.stringify(first.usage)}`)

  const messages: Array<OpenAI.ChatCompletionMessageParam> = [
    { role: "user", content: firstUser },
    { role: "assistant", content: firstReply },
    { role: "user", content: "Now run `echo hello-from-flue` with bash and tell me exactly what it printed." },
  ]
  const stream = yield* Effect.promise(() =>
    openai.chat.completions.create({ model, messages, stream: true })
  )
  yield* Effect.promise(async () => {
    let out = ""
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? ""
      out += delta
      process.stdout.write(delta)
    }
    return out
  })
  yield* Console.log("")

  const models = yield* Effect.promise(() => openai.models.list())
  const ids = models.data.map((m) => m.id)
  yield* Console.log(`session in /v1/models: ${ids.includes(model)}`)
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
