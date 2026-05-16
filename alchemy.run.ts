import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import { localState } from "alchemy/State"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import * as path from "node:path"

import Api from "./apps/api/src/Api.ts"
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

const computeContentsHash = async (): Promise<string> => {
  const skillsDir = path.join("apps", "api", "skills")
  const rolesDir = path.join("apps", "api", "roles")

  const pairs: Array<{ relPath: string; content: string }> = []

  for (const entry of await listMarkdown(skillsDir)) {
    const relPath = `skills/${entry}`
    const content = await readFile(path.join(skillsDir, entry), "utf8")
    pairs.push({ relPath, content })
  }

  for (const entry of await listMarkdown(rolesDir)) {
    const relPath = `roles/${entry}`
    const content = await readFile(path.join(rolesDir, entry), "utf8")
    pairs.push({ relPath, content })
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
    })
    const api = yield* Api
    return { url: api.url.as<string>() }
  }),
)
