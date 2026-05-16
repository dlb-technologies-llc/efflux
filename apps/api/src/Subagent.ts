/**
 * Stateless one-shot subagent. Runs a focused prompt against OpenRouter with
 * an optional named system prompt (role) and returns just the assistant text.
 *
 * Deliberately does NOT touch any DurableObject session — no history is
 * persisted and no parent state is mutated. The HTTP endpoint lives at
 * top-level `POST /tasks` for this reason (not per-session). See issue #4.
 *
 * `role` is a closed `Schema.Literals` enum (`TaskRole`) so unknown values
 * fail at the HTTP boundary with a structured schema error, not deeper here.
 */
import { AgentError, type TaskRole } from "@effect-flue/shared"
import { Effect } from "effect"
import supportMd from "../skills/support.md" with { type: "text" }
import { DEFAULT_MODEL, callOpenRouter } from "./OpenRouterClient.ts"

const stripFrontmatter = (s: string): string => {
  const match = s.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/)
  return match === null ? s.trim() : s.slice(match[0].length).trim()
}

const ROLE_REGISTRY: Record<TaskRole, string> = {
  support: stripFrontmatter(supportMd),
}

export const runSubagent = (args: {
  readonly apiKey: string
  readonly prompt: string
  readonly role?: TaskRole
  readonly model?: string
}): Effect.Effect<
  { readonly text: string; readonly model: string; readonly finishReason: string },
  AgentError
> =>
  Effect.gen(function* () {
    const systemPrompt =
      args.role !== undefined ? ROLE_REGISTRY[args.role] : undefined
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
