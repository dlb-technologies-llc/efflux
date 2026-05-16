import { Effect } from "effect"

export const DEFAULT_MODEL = "anthropic/claude-sonnet-4-6"

export const callOpenRouter = (
  apiKey: string,
  model: string,
  messages: ReadonlyArray<{ role: string; content: string }>,
) =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model, messages }),
      })
      const body = await res.text()
      if (!res.ok) {
        throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 500)}`)
      }
      const json = JSON.parse(body) as {
        choices: Array<{
          message: { content: string }
          finish_reason: string
        }>
        model: string
      }
      const choice = json.choices[0]
      if (!choice) {
        throw new Error(`OpenRouter returned no choices: ${body.slice(0, 500)}`)
      }
      return {
        text: choice.message.content,
        finishReason: choice.finish_reason,
        model: json.model,
      }
    },
    catch: (cause) =>
      cause instanceof Error
        ? cause
        : new Error(`OpenRouter call failed: ${String(cause)}`),
  })
