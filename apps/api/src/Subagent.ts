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
import * as OpenRouterLanguageModel from "@effect/ai-openrouter/OpenRouterLanguageModel"
import {
  AgentError,
  RoleNotFoundError,
  SkillNotFoundError,
} from "@effect-flue/shared"
import { Effect } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import { DEFAULT_MODEL } from "./Defaults.ts"
import { SkillsBucket, loadRoleBody, loadSkillBody } from "./Skills.ts"

// Anti-recursion cap: this function does NOT pass a `toolkit` to
// generateText. Subagents therefore cannot themselves call tools
// (including `spawn_subagent`). Do not add a `toolkit` parameter here
// without designing depth tracking first. See SpawnSubagentTool.ts.
export const runSubagent = (args: {
  readonly prompt: string
  readonly skill?: string
  readonly role?: string
  readonly model?: string
}): Effect.Effect<
  {
    readonly text: string
    readonly model: string
    readonly finishReason: string
  },
  AgentError | SkillNotFoundError | RoleNotFoundError,
  LanguageModel.LanguageModel | SkillsBucket
> =>
  Effect.gen(function* () {
    const skillBody =
      args.skill !== undefined ? yield* loadSkillBody(args.skill) : undefined
    const roleBody =
      args.role !== undefined ? yield* loadRoleBody(args.role) : undefined

    const messages: Array<{ role: "system" | "user"; content: string }> = []
    if (skillBody !== undefined) {
      messages.push({ role: "system", content: skillBody })
    }
    if (roleBody !== undefined) {
      messages.push({ role: "system", content: roleBody })
    }
    messages.push({ role: "user", content: args.prompt })

    const call = LanguageModel.generateText({ prompt: messages })
    // Per-call model override via OpenRouter's Config service. When the
    // caller didn't supply `model`, fall back to the layer's default.
    const withModel =
      args.model !== undefined
        ? OpenRouterLanguageModel.withConfigOverride(call, {
            model: args.model,
          })
        : call

    const response = yield* withModel.pipe(
      Effect.catch((cause) =>
        Effect.fail(
          new AgentError({
            message:
              cause instanceof Error
                ? cause.message
                : `runSubagent failed: ${String(cause)}`,
          }),
        ),
      ),
    )

    return {
      text: response.text,
      model: args.model ?? DEFAULT_MODEL,
      finishReason: response.finishReason,
    }
  })
