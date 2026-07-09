import {
  AgentError,
  RoleNotFoundError,
  SkillNotFoundError,
} from "@effect-flue/shared"
import { Context, Effect } from "effect"

/** Runtime handle to the skills R2 bucket, provided per-isolate from `env.SKILLS`. */
export class SkillsBucket extends Context.Service<SkillsBucket, R2Bucket>()(
  "api/SkillsBucket",
) {}

/** Per-isolate cache: markdown bodies change only on redeploy (new isolate), so caching for the isolate's life avoids an R2 round-trip per prompt. */
const bodyCache = new Map<string, string>()

/** Strip leading YAML frontmatter; the `endsWith("\n---")` guard handles a frontmatter-only file with no trailing newline so YAML never leaks into the system prompt. */
const stripFrontmatter = (text: string): string => {
  if (!text.startsWith("---\n")) return text.trim()
  const end = text.indexOf("\n---\n", 4)
  if (end !== -1) return text.slice(end + 5).trim()
  if (text.endsWith("\n---")) return ""
  return text.trim()
}

const loadBody = <E>(
  key: string,
  notFound: (key: string) => E,
): Effect.Effect<string, E | AgentError, SkillsBucket> =>
  Effect.gen(function* () {
    const cached = bodyCache.get(key)
    if (cached !== undefined) return cached

    const bucket = yield* SkillsBucket
    const obj = yield* Effect.tryPromise({
      try: () => bucket.get(key),
      catch: (e) =>
        new AgentError({
          message: `R2 get failed for ${key}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        }),
    })

    if (obj === null) return yield* Effect.fail(notFound(key))

    const text = yield* Effect.tryPromise({
      try: () => obj.text(),
      catch: (e) =>
        new AgentError({
          message: `R2 body read failed for ${key}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        }),
    })

    const body = stripFrontmatter(text)
    bodyCache.set(key, body)
    return body
  })

export const loadSkillBody = Effect.fn("loadSkillBody")(function* (
  name: string,
): Effect.fn.Return<string, SkillNotFoundError | AgentError, SkillsBucket> {
  return yield* loadBody(
    `skills/${name}.md`,
    (key) => new SkillNotFoundError({ skill: name, key }),
  )
})

export const loadRoleBody = Effect.fn("loadRoleBody")(function* (
  name: string,
): Effect.fn.Return<string, RoleNotFoundError | AgentError, SkillsBucket> {
  return yield* loadBody(
    `roles/${name}.md`,
    (key) => new RoleNotFoundError({ role: name, key }),
  )
})
