/**
 * Preflight for `bun run dev:local`: validate `.dev.vars`, then rebuild the web
 * FE with `VITE_API_TOKEN` injected and confirm the token actually inlined into
 * the emitted bundle. Fails fast with an actionable message so a misconfigured
 * local env never boots a silently-broken server (empty FE bearer → every panel
 * 401s; a missing SECRETS_ENCRYPTION_KEY → the secrets feature 500s at runtime).
 */
import { Console, Effect } from "effect"
import { readdir, readFile } from "node:fs/promises"
import * as path from "node:path"
import { reportExit } from "./lib.ts"

const REQUIRED_KEYS: ReadonlyArray<string> = ["API_TOKEN", "VITE_API_TOKEN", "OPENROUTER_API_KEY", "SECRETS_ENCRYPTION_KEY"]

/** Parsed `.dev.vars` plus human-readable structural problems (missing/duplicate keys, token mismatch). */
export interface DevVarsCheck {
  readonly values: Readonly<Record<string, string>>
  readonly errors: ReadonlyArray<string>
}

/** Parse dotenv-style `.dev.vars` text and validate it against what `dev:local` needs. Pure — no IO — so it is unit-testable without the real file. */
export const validateDevVars = (raw: string): DevVarsCheck => {
  const values: Record<string, string> = {}
  const counts = new Map<string, number>()
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "")
    counts.set(key, (counts.get(key) ?? 0) + 1)
    values[key] = value
  }
  const errors: Array<string> = []
  for (const key of REQUIRED_KEYS) {
    if (values[key] === undefined) errors.push(`${key} is missing from .dev.vars`)
  }
  for (const [key, count] of counts) {
    if (count > 1) errors.push(`${key} appears ${count}× in .dev.vars — remove the duplicate (ambiguous which value the worker uses)`)
  }
  const api = values["API_TOKEN"]
  const vite = values["VITE_API_TOKEN"]
  if (api !== undefined && vite !== undefined && api !== vite) {
    errors.push("VITE_API_TOKEN must equal API_TOKEN (the FE bearer must match the worker's) — they differ")
  }
  if (values["OPENROUTER_API_KEY"] === "sk-or-your-key-here") {
    errors.push("OPENROUTER_API_KEY is still the .dev.vars.example placeholder — every model turn will fail with an empty SSE stream; set a real OpenRouter key")
  }
  return { values, errors }
}

/** Repo root, anchored to this script's dir (`<repoRoot>/scripts/`), so it works from any invocation cwd. */
const repoRoot = path.dirname(import.meta.dirname)

/** Fail unless SOME emitted `index-*.js` bundle contains the token — the definitive check that the empty-VITE_API_TOKEN trap did not recur. Scans ALL matches (not just the first) so a future Vite chunk-split of `runtime.ts` can't false-fail it. */
const assertTokenInlined = (token: string): Effect.Effect<void, Error> =>
  Effect.gen(function*() {
    const dir = path.join(repoRoot, "apps", "web", "dist", "assets")
    const files = yield* Effect.tryPromise({ try: () => readdir(dir), catch: (e) => new Error(`cannot read ${dir}: ${String(e)}`) })
    const bundles = files.filter((f) => f.startsWith("index-") && f.endsWith(".js"))
    if (bundles.length === 0) return yield* Effect.fail(new Error("no FE bundle emitted under apps/web/dist/assets"))
    for (const bundle of bundles) {
      const contents = yield* Effect.tryPromise({ try: () => readFile(path.join(dir, bundle), "utf8"), catch: (e) => new Error(String(e)) })
      if (contents.includes(token)) return
    }
    return yield* Effect.fail(new Error("FE build did not inline VITE_API_TOKEN into any index-*.js bundle — the bundle would 401 on every call"))
  })

const main = Effect.gen(function*() {
  const raw = yield* Effect.tryPromise({ try: () => readFile(path.join(repoRoot, ".dev.vars"), "utf8"), catch: () => new Error("cannot read .dev.vars at repo root — copy .dev.vars.example and fill it in") })
  const { values, errors } = validateDevVars(raw)
  if (errors.length > 0) {
    return yield* Effect.fail(new Error(`.dev.vars is not ready for \`bun run dev:local\`:\n  - ${errors.join("\n  - ")}`))
  }
  const token = values["VITE_API_TOKEN"]
  if (token === undefined) return yield* Effect.fail(new Error("VITE_API_TOKEN missing after validation"))
  yield* Console.log("preflight: .dev.vars OK — building FE with VITE_API_TOKEN inlined…")
  const proc = Bun.spawnSync(["bun", "run", "--filter", "@efflux/web", "build"], {
    env: { ...process.env, VITE_API_TOKEN: token },
    stdout: "inherit",
    stderr: "inherit",
  })
  if (!proc.success) return yield* Effect.fail(new Error(`FE build failed (exit ${proc.exitCode})`))
  yield* assertTokenInlined(token)
  yield* Console.log("preflight: FE bundle carries the token ✓ — seeding default skills/roles next")
})

if (import.meta.main) reportExit(await Effect.runPromiseExit(main))
