import { AgentError } from "@effect-flue/shared"
import * as r2 from "@distilled.cloud/cloudflare/r2"
import type * as runtime from "@cloudflare/workers-types"
import { Action } from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import { Context, Effect } from "effect"
import { readdir, readFile } from "node:fs/promises"
import * as path from "node:path"

/**
 * R2 bucket binding for skill + role markdown bodies.
 *
 * No explicit `name` arg — alchemy generates `${app}-${stage}-Skills` so
 * dev and prod stages don't collide on object keys.
 */
export const Skills = Cloudflare.R2Bucket("Skills")

/**
 * Runtime handle to the bucket inside a worker.
 *
 * We deliberately store the *native* `R2Bucket` (workerd's binding type)
 * rather than alchemy's `R2BucketClient` wrapper. The wrapper carries
 * `WorkerEnvironment` in every method's R channel; storing the resolved
 * native handle at the per-event entry keeps `loadSkillBody`'s requirement
 * down to just `SkillsBucket`.
 */
export class SkillsBucket extends Context.Service<
  SkillsBucket,
  runtime.R2Bucket
>()("api/SkillsBucket") {}

// Per-isolate cache. Markdown bodies don't change without a redeploy
// (which mints a new isolate), so caching for the lifetime of the isolate
// is safe and avoids a round-trip to R2 on every prompt.
const bodyCache = new Map<string, string>()

const stripFrontmatter = (text: string): string => {
  if (!text.startsWith("---\n")) return text.trim()
  const end = text.indexOf("\n---\n", 4)
  if (end === -1) return text.trim()
  return text.slice(end + 5).trim()
}

const loadBody = (
  key: string,
  notFoundLabel: string,
): Effect.Effect<string, AgentError, SkillsBucket> =>
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

    if (obj === null) {
      return yield* Effect.fail(
        new AgentError({ message: `${notFoundLabel} not found: ${key}` }),
      )
    }

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

export const loadSkillBody = (
  name: string,
): Effect.Effect<string, AgentError, SkillsBucket> =>
  loadBody(`skills/${name}.md`, "Skill")

export const loadRoleBody = (
  name: string,
): Effect.Effect<string, AgentError, SkillsBucket> =>
  loadBody(`roles/${name}.md`, "Role")

// ── Deploy-time upload action ──────────────────────────────────────────────
//
// Resolves CF API services once (in the init Effect), then returns a runner
// that walks `apps/api/skills/*.md` + `apps/api/roles/*.md` and PUTs each
// file to R2 under a stable key. The `contentsHash` input is what alchemy
// diffs against — when it changes, the runner re-runs and re-uploads.

const isEnoent = (e: unknown): boolean => {
  if (e === null || typeof e !== "object" || !("code" in e)) return false
  const { code } = e
  return code === "ENOENT"
}

export const UploadSkills = Action(
  "UploadSkills",
  Effect.gen(function* () {
    const putObject = yield* r2.putObject
    const { accountId } = yield* Cloudflare.CloudflareEnvironment

    const uploadDir = (
      bucketName: string,
      jurisdiction: "default" | "eu" | "fedramp" | undefined,
      dir: string,
      keyPrefix: string,
    ) =>
      Effect.gen(function* () {
        const listResult = yield* Effect.tryPromise({
          try: async (): Promise<ReadonlyArray<string> | null> => {
            try {
              return await readdir(dir)
            } catch (e) {
              if (isEnoent(e)) return null
              throw e
            }
          },
          catch: (e) =>
            new AgentError({
              message: `Failed to list ${dir}: ${
                e instanceof Error ? e.message : String(e)
              }`,
            }),
        })

        if (listResult === null) return

        for (const entry of listResult) {
          if (!entry.endsWith(".md")) continue
          const body = yield* Effect.tryPromise({
            try: () => readFile(path.join(dir, entry), "utf8"),
            catch: (e) =>
              new AgentError({
                message: `Failed to read ${entry}: ${
                  e instanceof Error ? e.message : String(e)
                }`,
              }),
          })
          yield* putObject({
            accountId,
            bucketName,
            objectName: `${keyPrefix}/${entry}`,
            body,
            contentType: "text/markdown",
            ...(jurisdiction !== undefined
              ? { cfR2Jurisdiction: jurisdiction }
              : {}),
          })
        }
      })

    return Effect.fn("UploadSkills.run")(function* (input: {
      contentsHash: string
      bucketName: string
      jurisdiction?: "default" | "eu" | "fedramp"
      // Absolute paths resolved by `alchemy.run.ts` from `import.meta.dirname`
      // so the upload is independent of the deploy CWD.
      skillsDir: string
      rolesDir: string
    }) {
      yield* uploadDir(
        input.bucketName,
        input.jurisdiction,
        input.skillsDir,
        "skills",
      )
      yield* uploadDir(
        input.bucketName,
        input.jurisdiction,
        input.rolesDir,
        "roles",
      )
      return { contentsHash: input.contentsHash }
    })
  }),
)
