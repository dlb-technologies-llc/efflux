// Uploads every skill and role markdown file to the effect-flue-skills R2
// bucket via `wrangler r2 object put`. No hash/diff machinery — always
// uploads everything. Run with --dry-run to list what would be uploaded
// without touching R2.

import { $ } from "bun"
import { readdir } from "node:fs/promises"
import * as path from "node:path"

const isEnoent = (e: unknown): boolean => {
  if (e === null || typeof e !== "object" || !("code" in e)) return false
  const { code } = e
  return code === "ENOENT"
}

const listMarkdown = async (dir: string): Promise<ReadonlyArray<string>> => {
  try {
    const entries = await readdir(dir)
    return entries.filter((entry) => entry.endsWith(".md")).sort()
  } catch (e) {
    if (isEnoent(e)) return []
    throw e
  }
}

// Anchor to this script's location, not `process.cwd()`, so the markdown
// discovery works no matter which directory the script is invoked from.
// This file lives at <repoRoot>/scripts/upload-skills.ts.
const repoRoot = path.dirname(import.meta.dirname)
const SKILLS_DIR = path.join(repoRoot, "apps", "api", "skills")
const ROLES_DIR = path.join(repoRoot, "apps", "api", "roles")

const BUCKET = "effect-flue-skills"

const dryRun = process.argv.includes("--dry-run")

interface Upload {
  readonly key: string
  readonly file: string
}

const uploads: Array<Upload> = []

for (const entry of await listMarkdown(SKILLS_DIR)) {
  uploads.push({ key: `skills/${entry}`, file: path.join(SKILLS_DIR, entry) })
}
for (const entry of await listMarkdown(ROLES_DIR)) {
  uploads.push({ key: `roles/${entry}`, file: path.join(ROLES_DIR, entry) })
}

// A run with zero markdown files is almost certainly a path-resolution bug,
// not an intentional empty catalog. Fail loudly so we don't silently ship
// an empty R2 bucket.
if (uploads.length === 0) {
  console.error(
    `No skill or role markdown files found under ${SKILLS_DIR} or ${ROLES_DIR}. ` +
      `Refusing to proceed with an empty upload set.`,
  )
  process.exit(1)
}

if (dryRun) {
  console.log(`[dry-run] would upload ${uploads.length} object(s) to ${BUCKET}:`)
  for (const { key, file } of uploads) {
    console.log(`[dry-run]   ${BUCKET}/${key}  <-  ${file}`)
  }
  process.exit(0)
}

for (const { key, file } of uploads) {
  console.log(`uploading ${BUCKET}/${key}  <-  ${file}`)
  const { exitCode } =
    await $`bunx wrangler r2 object put ${`${BUCKET}/${key}`} --file ${file} --remote`.nothrow()
  if (exitCode !== 0) {
    console.error(`upload of ${BUCKET}/${key} failed with exit code ${exitCode}`)
    process.exit(exitCode)
  }
}

console.log(`uploaded ${uploads.length} object(s) to ${BUCKET}`)
