#!/usr/bin/env bun
/** Stock `openai` SDK smoke: drives a tool-using conversation through the `/v1` facade to prove any OpenAI client can treat an efflux session as a model. */

import { Console, Effect } from "effect"
import OpenAI from "openai"
import { ApiClient, bootstrap, runMain } from "./lib.ts"

const USAGE = "Usage: bun run openai-smoke <name> <id> [--url URL]"

const { base, parsed, runtime } = bootstrap(process.argv.slice(2), new Set(), USAGE)

const name = parsed.positional[0]
const id = parsed.positional[1]
if (name === undefined || id === undefined) {
  console.error(USAGE)
  process.exit(1)
}

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
  const first = yield* Effect.tryPromise({
    try: () => openai.chat.completions.create({ model, messages: [{ role: "user", content: firstUser }] }),
    catch: (error) => error,
  })
  const firstReply = first.choices[0]?.message?.content ?? ""
  yield* Console.log(`non-stream reply: ${firstReply}`)
  yield* Console.log(`non-stream usage: ${JSON.stringify(first.usage)}`)

  const messages: Array<OpenAI.ChatCompletionMessageParam> = [
    { role: "user", content: firstUser },
    { role: "assistant", content: firstReply },
    { role: "user", content: "Now run `echo hello-from-efflux` with bash and tell me exactly what it printed." },
  ]
  const stream = yield* Effect.tryPromise({
    try: () => openai.chat.completions.create({ model, messages, stream: true }),
    catch: (error) => error,
  })
  yield* Effect.tryPromise({
    try: async () => {
      let out = ""
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content ?? ""
        out += delta
        process.stdout.write(delta)
      }
      return out
    },
    catch: (error) => error,
  })
  yield* Console.log("")

  const models = yield* Effect.tryPromise({ try: () => openai.models.list(), catch: (error) => error })
  const ids = models.data.map((m) => m.id)
  yield* Console.log(`session in /v1/models: ${ids.includes(model)}`)
})

await runMain(main, runtime)
