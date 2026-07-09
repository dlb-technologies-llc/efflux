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

/** Cross-isolate staleness bound for cached bodies: runtime PUT means bodies now change without a redeploy, so a lifetime cache would serve stale text; a short TTL bounds cross-isolate staleness while the writing isolate invalidates immediately. */
const BODY_CACHE_TTL_MS = 60_000

/** Per-isolate body cache keyed by R2 key, holding the stripped body plus its fetch time so {@link loadBody} can expire it after {@link BODY_CACHE_TTL_MS}. Roles share this one path and inherit the TTL harmlessly — they have no runtime CRUD, so no staleness risk, only a negligible R2 re-fetch per role per TTL per isolate. */
const bodyCache = new Map<string, { body: string; at: number }>()

/** Drop a skill's cached body so the isolate that just wrote it never serves its own stale pre-write text. */
export const invalidateSkillCache = (name: string): void => {
  bodyCache.delete(`skills/${name}.md`)
}

/** Strip leading YAML frontmatter; the `endsWith("\n---")` guard handles a frontmatter-only file with no trailing newline so YAML never leaks into the system prompt. */
const stripFrontmatter = (text: string): string => {
  if (!text.startsWith("---\n")) return text.trim()
  const end = text.indexOf("\n---\n", 4)
  if (end !== -1) return text.slice(end + 5).trim()
  if (text.endsWith("\n---")) return ""
  return text.trim()
}

/** Read the `description:` value out of a file's leading YAML frontmatter block (name comes from the R2 key); returns `""` when there is no frontmatter or no description line. */
const frontmatterDescription = (text: string): string => {
  if (!text.startsWith("---\n")) return ""
  const end = text.indexOf("\n---", 4)
  const block = end === -1 ? text.slice(4) : text.slice(4, end)
  for (const line of block.split("\n")) {
    const m = /^description:\s*(.*)$/.exec(line)
    if (m !== null) return (m[1] ?? "").trim()
  }
  return ""
}

const loadBody = <E>(
  key: string,
  notFound: (key: string) => E,
): Effect.Effect<string, E | AgentError, SkillsBucket> =>
  Effect.gen(function* () {
    const cached = bodyCache.get(key)
    if (cached !== undefined && Date.now() - cached.at < BODY_CACHE_TTL_MS) {
      return cached.body
    }

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
    bodyCache.set(key, { body, at: Date.now() })
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

/** List the skill catalog for management: `name` from the R2 key, `description` from each object's frontmatter. One extra R2 get per `.md` object — N gets is fine for the small catalog — sorted by name. */
export const listSkills = Effect.fn("listSkills")(function* (): Effect.fn.Return<
  ReadonlyArray<{ name: string; description: string }>,
  AgentError,
  SkillsBucket
> {
  const bucket = yield* SkillsBucket
  const listed = yield* Effect.tryPromise({
    try: () => bucket.list({ prefix: "skills/" }),
    catch: (e) =>
      new AgentError({
        message: `R2 list failed for skills/: ${
          e instanceof Error ? e.message : String(e)
        }`,
      }),
  })

  const skills: Array<{ name: string; description: string }> = []
  for (const object of listed.objects) {
    if (!object.key.endsWith(".md")) continue
    const obj = yield* Effect.tryPromise({
      try: () => bucket.get(object.key),
      catch: (e) =>
        new AgentError({
          message: `R2 get failed for ${object.key}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        }),
    })
    if (obj === null) continue
    const text = yield* Effect.tryPromise({
      try: () => obj.text(),
      catch: (e) =>
        new AgentError({
          message: `R2 body read failed for ${object.key}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        }),
    })
    const name = object.key.slice("skills/".length, -".md".length)
    skills.push({ name, description: frontmatterDescription(text) })
  }
  skills.sort((a, b) => a.name.localeCompare(b.name))
  return skills
})

/** Read a skill's RAW markdown (frontmatter included) for the management view; bypasses {@link bodyCache} so it always reflects the current R2 object, and 404s when the skill is absent. */
export const getSkillRaw = Effect.fn("getSkillRaw")(function* (
  name: string,
): Effect.fn.Return<string, SkillNotFoundError | AgentError, SkillsBucket> {
  const key = `skills/${name}.md`
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

  if (obj === null) {
    return yield* Effect.fail(new SkillNotFoundError({ skill: name, key }))
  }

  return yield* Effect.tryPromise({
    try: () => obj.text(),
    catch: (e) =>
      new AgentError({
        message: `R2 body read failed for ${key}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      }),
  })
})

/** Write a skill body to R2, then invalidate this isolate's cache so it never serves the pre-write text. */
export const putSkillBody = Effect.fn("putSkillBody")(function* (
  name: string,
  content: string,
): Effect.fn.Return<void, AgentError, SkillsBucket> {
  const key = `skills/${name}.md`
  const bucket = yield* SkillsBucket
  yield* Effect.tryPromise({
    try: () => bucket.put(key, content),
    catch: (e) =>
      new AgentError({
        message: `R2 put failed for ${key}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      }),
  })
  invalidateSkillCache(name)
})

/** Delete a skill object, 404ing when it is absent: R2 `delete` is idempotent/void, so head first to distinguish a real delete from a missing skill, then invalidate the cache. */
export const deleteSkillObject = Effect.fn("deleteSkillObject")(function* (
  name: string,
): Effect.fn.Return<void, SkillNotFoundError | AgentError, SkillsBucket> {
  const key = `skills/${name}.md`
  const bucket = yield* SkillsBucket
  const existing = yield* Effect.tryPromise({
    try: () => bucket.head(key),
    catch: (e) =>
      new AgentError({
        message: `R2 head failed for ${key}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      }),
  })

  if (existing === null) {
    return yield* Effect.fail(new SkillNotFoundError({ skill: name, key }))
  }

  yield* Effect.tryPromise({
    try: () => bucket.delete(key),
    catch: (e) =>
      new AgentError({
        message: `R2 delete failed for ${key}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      }),
  })
  invalidateSkillCache(name)
})
