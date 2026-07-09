/** Uploads every skill/role markdown file to the effect-flue-skills R2 bucket via `wrangler r2 object put` (always full upload, no diff). Pass --dry-run to list only. */

import { $ } from "bun"
import { Console, Effect } from "effect"
import { readdir } from "node:fs/promises"
import * as path from "node:path"
import { reportExit } from "./lib.ts"

const isEnoent = (e: unknown): boolean =>
  e !== null && typeof e === "object" && "code" in e && e.code === "ENOENT"

/** Sorted `.md` filenames in `dir`; a missing directory is an empty catalog, not a failure. */
const listMarkdown = (dir: string): Effect.Effect<ReadonlyArray<string>, unknown> =>
  Effect.tryPromise({ try: () => readdir(dir), catch: (e: unknown) => e }).pipe(
    Effect.map((entries) => entries.filter((entry) => entry.endsWith(".md")).sort()),
    Effect.catchIf(
      (e: unknown) => isEnoent(e),
      () => Effect.succeed<ReadonlyArray<string>>([]),
    ),
  )

/** Repo root, anchored to this script's dir (`<repoRoot>/scripts/`), not `process.cwd()`, so discovery works from any invocation directory. */
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

reportExit(await Effect.runPromiseExit(main))
