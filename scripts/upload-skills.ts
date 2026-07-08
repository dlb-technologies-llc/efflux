// Uploads every skill and role markdown file to the effect-flue-skills R2
// bucket via `wrangler r2 object put`. No hash/diff machinery — always uploads
// everything. Run with --dry-run to list what would be uploaded.
//
// The work is one Effect; the process edge (argv, exit code) is the boundary.

import { $ } from "bun"
import { Cause, Console, Effect, Exit } from "effect"
import { readdir } from "node:fs/promises"
import * as path from "node:path"

const isEnoent = (e: unknown): boolean =>
  e !== null && typeof e === "object" && "code" in e && e.code === "ENOENT"

const listMarkdown = (dir: string): Effect.Effect<ReadonlyArray<string>, unknown> =>
  Effect.tryPromise({ try: () => readdir(dir), catch: (e: unknown) => e }).pipe(
    Effect.map((entries) => entries.filter((entry) => entry.endsWith(".md")).sort()),
    // A missing directory is an empty catalog, not a failure; anything else
    // stays in the error channel.
    Effect.catchIf(
      (e: unknown) => isEnoent(e),
      () => Effect.succeed<ReadonlyArray<string>>([]),
    ),
  )

// Anchor to this script's location, not `process.cwd()`, so discovery works
// from any invocation directory. This file lives at <repoRoot>/scripts/.
const repoRoot = path.dirname(import.meta.dirname)
const SKILLS_DIR = path.join(repoRoot, "apps", "api", "skills")
const ROLES_DIR = path.join(repoRoot, "apps", "api", "roles")
const BUCKET = "effect-flue-skills"
const dryRun = process.argv.includes("--dry-run")

const main = Effect.gen(function*() {
  const skillFiles = yield* listMarkdown(SKILLS_DIR)
  const roleFiles = yield* listMarkdown(ROLES_DIR)
  const uploads = [
    ...skillFiles.map((entry) => ({ key: `skills/${entry}`, file: path.join(SKILLS_DIR, entry) })),
    ...roleFiles.map((entry) => ({ key: `roles/${entry}`, file: path.join(ROLES_DIR, entry) })),
  ]

  // Zero markdown files is almost certainly a path-resolution bug, not an
  // intentional empty catalog — fail loudly rather than ship an empty bucket.
  if (uploads.length === 0) {
    return yield* Effect.fail(
      new Error(
        `No skill or role markdown files found under ${SKILLS_DIR} or ${ROLES_DIR}. ` +
          `Refusing to proceed with an empty upload set.`,
      ),
    )
  }

  if (dryRun) {
    yield* Console.log(`[dry-run] would upload ${uploads.length} object(s) to ${BUCKET}:`)
    yield* Effect.forEach(uploads, ({ file, key }) =>
      Console.log(`[dry-run]   ${BUCKET}/${key}  <-  ${file}`))
    return
  }

  yield* Effect.forEach(uploads, ({ file, key }) =>
    Effect.gen(function*() {
      yield* Console.log(`uploading ${BUCKET}/${key}  <-  ${file}`)
      const { exitCode } = yield* Effect.tryPromise(() =>
        $`bunx wrangler r2 object put ${`${BUCKET}/${key}`} --file ${file} --remote`.nothrow())
      if (exitCode !== 0) {
        return yield* Effect.fail(
          new Error(`upload of ${BUCKET}/${key} failed with exit code ${exitCode}`),
        )
      }
    }))

  yield* Console.log(`uploaded ${uploads.length} object(s) to ${BUCKET}`)
})

const result = await Effect.runPromiseExit(main)
if (Exit.isFailure(result)) {
  const failReason = result.cause.reasons.find(Cause.isFailReason)
  console.error(
    failReason !== undefined
      ? (failReason.error instanceof Error ? failReason.error.message : String(failReason.error))
      : Cause.pretty(result.cause),
  )
}
// Normalize to 0/1 — never forward a subprocess's mod-256 code verbatim.
process.exitCode = Exit.isSuccess(result) ? 0 : 1
