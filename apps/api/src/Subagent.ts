import { AgentError } from "@effect-flue/shared"
import { Effect } from "effect"
import supportMd from "../skills/support.md" with { type: "text" }
import { DEFAULT_MODEL, callOpenRouter } from "./OpenRouterClient.ts"

const stripFrontmatter = (s: string): string => {
  const trimmed = s.trimStart()
  if (!trimmed.startsWith("---\n") && !trimmed.startsWith("---\r\n")) return s
  const rest = trimmed.slice(trimmed.indexOf("\n") + 1)
  const end = rest.search(/^---\r?\n/m)
  if (end === -1) return s
  return rest.slice(end + rest.slice(end).indexOf("\n") + 1).trim()
}

const ROLE_REGISTRY: Record<string, string> = {
  support: stripFrontmatter(supportMd),
}

export const runSubagent = (args: {
  readonly apiKey: string
  readonly prompt: string
  readonly role?: string
  readonly model?: string
}): Effect.Effect<
  { readonly text: string; readonly model: string; readonly finishReason: string },
  AgentError
> =>
  Effect.gen(function* () {
    // Resolve system prompt: known role -> registered prompt; unknown role -> typed
    // error; no role -> raw passthrough (no system message).
    let systemPrompt: string | undefined
    if (args.role !== undefined) {
      const registered = ROLE_REGISTRY[args.role]
      if (registered === undefined) {
        return yield* Effect.fail(
          new AgentError({ message: `Unknown role: ${args.role}` }),
        )
      }
      systemPrompt = registered
    }

    const messages =
      systemPrompt !== undefined
        ? [
            { role: "system", content: systemPrompt },
            { role: "user", content: args.prompt },
          ]
        : [{ role: "user", content: args.prompt }]

    const result = yield* callOpenRouter(
      args.apiKey,
      args.model ?? DEFAULT_MODEL,
      messages,
    ).pipe(
      Effect.catch((e: Error) =>
        Effect.fail(new AgentError({ message: e.message })),
      ),
    )

    return {
      text: result.text,
      model: result.model,
      finishReason: result.finishReason,
    }
  })
