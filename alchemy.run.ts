import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import { localState } from "alchemy/State"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import * as path from "node:path"

import Api from "./apps/api/src/Api.ts"
import SandboxLive from "./apps/api/src/Sandbox.runtime.ts"
import { Skills, UploadSkills } from "./apps/api/src/Skills.ts"

const isEnoent = (e: unknown): boolean => {
  if (e === null || typeof e !== "object" || !("code" in e)) return false
  const { code } = e
  return code === "ENOENT"
}

const listMarkdown = async (dir: string): Promise<ReadonlyArray<string>> => {
  try {
    const entries = await readdir(dir)
    return entries.filter((entry) => entry.endsWith(".md"))
  } catch (e) {
    if (isEnoent(e)) return []
    throw e
  }
}

// `import.meta.dirname` resolves to this file's directory, which IS the
// repo root since `alchemy.run.ts` lives there. Anchoring to it makes the
// markdown discovery independent of `process.cwd()` — `bun alchemy deploy`
// invoked from any subdirectory or CI wrapper still finds the same files.
const repoRoot = import.meta.dirname
const SKILLS_DIR = path.join(repoRoot, "apps", "api", "skills")
const ROLES_DIR = path.join(repoRoot, "apps", "api", "roles")

const computeContentsHash = async (): Promise<string> => {
  const pairs: Array<{ relPath: string; content: string }> = []

  for (const entry of await listMarkdown(SKILLS_DIR)) {
    pairs.push({
      relPath: `skills/${entry}`,
      content: await readFile(path.join(SKILLS_DIR, entry), "utf8"),
    })
  }

  for (const entry of await listMarkdown(ROLES_DIR)) {
    pairs.push({
      relPath: `roles/${entry}`,
      content: await readFile(path.join(ROLES_DIR, entry), "utf8"),
    })
  }

  // A successful deploy with zero markdown files is almost certainly a
  // path-resolution bug, not an intentional empty catalog. Fail loudly so
  // we don't silently ship an empty R2 bucket.
  if (pairs.length === 0) {
    throw new Error(
      `No skill or role markdown files found under ${SKILLS_DIR} or ${ROLES_DIR}. ` +
        `Refusing to proceed with an empty UploadSkills payload.`,
    )
  }

  pairs.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))

  const hash = createHash("sha256")
  for (const { relPath, content } of pairs) {
    hash.update(`${relPath}\0${content}`)
  }
  return hash.digest("hex")
}

const contentsHash = await computeContentsHash()

export default Alchemy.Stack(
  "EffectFlue",
  {
    providers: Cloudflare.providers(),
    state: localState(),
  },
  Effect.gen(function* () {
    const skills = yield* Skills
    yield* UploadSkills({
      contentsHash,
      bucketName: skills.bucketName,
      jurisdiction: skills.jurisdiction,
      skillsDir: SKILLS_DIR,
      rolesDir: ROLES_DIR,
    })
    const api = yield* Api
    return { url: api.url.as<string>() }
  }).pipe(Effect.provide(SandboxLive)),
)
