/**
 * Stateless one-shot subagent: run a focused prompt against OpenRouter, optionally
 * overlaying a skill/role system prompt from R2. Touches no DurableObject session
 * (lives at top-level `POST /tasks`). With neither skill nor role, it's a raw
 * passthrough to OpenRouter (no system message).
 */
import * as OpenRouterLanguageModel from "@effect/ai-openrouter/OpenRouterLanguageModel"
import type {
  AgentError,
  RoleNotFoundError,
  SkillNotFoundError,
} from "@efflux/shared"
import { Effect } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import { MODEL_HOP_TIMEOUT, toAgentError } from "./AgentLoop.ts"
import { DEFAULT_MODEL } from "./Defaults.ts"
import { type SkillsBucket, loadRoleBody, loadSkillBody } from "./Skills.ts"

/** Run a focused subtask. Anti-recursion: passes NO toolkit to generateText, so subagents cannot call tools (incl. spawn_subagent) — don't add a toolkit param without designing depth tracking first. */
export const runSubagent = Effect.fn("runSubagent")(function* (args: {
  readonly prompt: string
  readonly skill?: string
  readonly role?: string
  readonly model?: string
}): Effect.fn.Return<
  {
    readonly text: string
    readonly model: string
    readonly finishReason: string
  },
  AgentError | SkillNotFoundError | RoleNotFoundError,
  LanguageModel.LanguageModel | SkillsBucket
> {
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
  const withModel =
    args.model !== undefined
      ? OpenRouterLanguageModel.withConfigOverride(call, {
          model: args.model,
        })
      : call

  const response = yield* withModel.pipe(
    Effect.timeout(MODEL_HOP_TIMEOUT),
    Effect.catch(toAgentError("runSubagent")),
  )

  return {
    text: response.text,
    model: args.model ?? DEFAULT_MODEL,
    finishReason: response.finishReason,
  }
})
