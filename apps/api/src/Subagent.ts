/**
 * Stateless one-shot subagent. Runs a focused prompt against OpenRouter,
 * optionally overlaying a skill and/or role system prompt loaded from R2.
 *
 * Deliberately does NOT touch any DurableObject session — no history is
 * persisted and no parent state is mutated. The HTTP endpoint lives at
 * top-level `POST /tasks` for this reason (not per-session). See issue #4.
 *
 * Both `skill` and `role` are open `SafeName`-bounded strings that resolve
 * to `skills/<name>.md` / `roles/<name>.md` in the `Skills` R2 bucket. The
 * subagent intentionally does NOT default `skill` to `"support"` the way
 * the prompt/stream handlers do — when neither is supplied, the request is
 * a raw passthrough to OpenRouter (no system message), matching the prior
 * "role omitted" behavior of this endpoint.
 */
import { AgentError } from "@effect-flue/shared"
import { Effect } from "effect"
import { DEFAULT_MODEL, callOpenRouter } from "./OpenRouterClient.ts"
import { SkillsBucket, loadRoleBody, loadSkillBody } from "./Skills.ts"

export const runSubagent = (args: {
  readonly apiKey: string
  readonly prompt: string
  readonly skill?: string
  readonly role?: string
  readonly model?: string
}): Effect.Effect<
  { readonly text: string; readonly model: string; readonly finishReason: string },
  AgentError,
  SkillsBucket
> =>
  Effect.gen(function* () {
    const skillBody =
      args.skill !== undefined ? yield* loadSkillBody(args.skill) : undefined
    const roleBody =
      args.role !== undefined ? yield* loadRoleBody(args.role) : undefined

    const systemMessages = [
      ...(skillBody !== undefined
        ? [{ role: "system" as const, content: skillBody }]
        : []),
      ...(roleBody !== undefined
        ? [{ role: "system" as const, content: roleBody }]
        : []),
    ]
    const messages = [
      ...systemMessages,
      { role: "user" as const, content: args.prompt },
    ]

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
