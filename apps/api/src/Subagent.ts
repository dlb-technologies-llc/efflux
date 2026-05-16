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
 *
 * Why the prompt is inlined here rather than loaded from
 * `apps/api/skills/support.md`: alchemy's Rolldown bundler (beta.39) does not
 * honor the ESM `with { type: "text" }` import attribute for `.md` files. The
 * `.md` file at `apps/api/skills/` is kept as the canonical reference (linked
 * from the README), but the runtime value lives here. When alchemy gains a
 * `.md`-as-text loader, switch this back to an import.
 */
import { AgentError, type TaskRole } from "@effect-flue/shared"
import { Effect } from "effect"
import { DEFAULT_MODEL, callOpenRouter } from "./OpenRouterClient.ts"

const SUPPORT_PROMPT = `You are a customer support agent.

When the customer asks a question:
1. Search the knowledge base for relevant articles using the \`bash\` tool (e.g. \`grep -ri "<keyword>" /workspace/kb\`).
2. Read the most relevant file(s).
3. Write a helpful, concise response grounded in what you found.

If nothing relevant turns up, say so honestly rather than guessing.
Keep responses under 200 words.`

const ROLE_REGISTRY: Record<TaskRole, string> = {
  support: SUPPORT_PROMPT,
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
