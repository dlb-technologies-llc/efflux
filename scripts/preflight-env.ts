import * as path from "node:path"
import { readDevVars } from "./devvars.ts"

/** The `.dev.vars.example` placeholder OpenRouter key; a real deploy must replace it. */
export const PLACEHOLDER_OPENROUTER_KEY = "sk-or-your-key-here"

/** One human-readable problem per missing/placeholder required var; `[]` means the
 *  local secrets are deploy-ready. Pure over the parsed vars (`undefined` = `.dev.vars`
 *  absent) so it is unit-testable without touching the filesystem. */
export const validateDevVars = (
  vars: Record<string, string> | undefined,
): ReadonlyArray<string> => {
  if (vars === undefined) {
    return ["`.dev.vars` not found — copy `.dev.vars.example` to `.dev.vars` and fill in real values before deploying."]
  }
  const problems: Array<string> = []
  const openrouter = vars.OPENROUTER_API_KEY ?? ""
  if (openrouter === "") {
    problems.push("OPENROUTER_API_KEY is missing from `.dev.vars`.")
  } else if (openrouter === PLACEHOLDER_OPENROUTER_KEY) {
    problems.push("OPENROUTER_API_KEY is still the `.dev.vars.example` placeholder — set your real OpenRouter key.")
  }
  if ((vars.API_TOKEN ?? "") === "") {
    problems.push("API_TOKEN is missing from `.dev.vars` (the Authorization bearer for /agents, /v1, /skills, /knowledge; the FE's VITE_API_TOKEN is derived from it).")
  }
  return problems
}

if (import.meta.main) {
  const repoRoot = path.dirname(import.meta.dirname)
  const problems = validateDevVars(readDevVars(path.join(repoRoot, ".dev.vars")))
  if (problems.length > 0) {
    console.error(
      "Deploy preflight failed — `.dev.vars` is incomplete:\n" +
        problems.map((p) => `  • ${p}`).join("\n"),
    )
    process.exit(1)
  }
  console.log(
    "Deploy preflight OK — `.dev.vars` has a real OPENROUTER_API_KEY and an API_TOKEN.\n" +
      "Reminder: the deployed Worker's `wrangler secret put API_TOKEN` value must byte-match this `.dev.vars` API_TOKEN, or the FE (whose bearer is derived from it) still 401s.",
  )
}
