import { readFileSync } from "node:fs"

/** Remove one matching pair of surrounding single or double quotes, if present, matching
 *  wrangler's dotenv semantics so a quoted `API_TOKEN="abc"` never derives a `Bearer "abc"`
 *  that mismatches the Worker's unquoted secret. */
const stripQuotes = (value: string): string => {
  if (value.length >= 2) {
    const first = value[0]
    if ((first === "\"" || first === "'") && value[value.length - 1] === first) {
      return value.slice(1, -1)
    }
  }
  return value
}

/** Parse dotenv text into a flat map: skips blank and `#`-comment lines, splits each
 *  remaining line on its first `=`, trims key and value, and strips one surrounding
 *  quote pair from the value. Later duplicate keys win. */
export const parseDotenv = (text: string): Record<string, string> => {
  const result: Record<string, string> = {}
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim()
    if (line === "" || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    if (key === "") continue
    result[key] = stripQuotes(line.slice(eq + 1).trim())
  }
  return result
}

/** Read and parse a `.dev.vars`-style file. A missing file (ENOENT) yields `undefined`
 *  so callers can distinguish "no secrets file" from "empty file"; any other read error
 *  rethrows rather than being silently swallowed. */
export const readDevVars = (path: string): Record<string, string> | undefined => {
  try {
    return parseDotenv(readFileSync(path, "utf8"))
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined
    }
    throw error
  }
}

/** The FE's build-time bearer: an explicit non-empty value wins; otherwise the `.dev.vars`
 *  `API_TOKEN`; otherwise empty string (today's behavior). Pure and typechecked here so the
 *  derivation is unit-testable even though its only runtime caller (`vite.config.ts`) is in
 *  no typechecked tsconfig. */
export const resolveApiToken = (
  explicit: string | undefined,
  vars: Record<string, string> | undefined,
): string => {
  if (typeof explicit === "string" && explicit !== "") return explicit
  return vars?.API_TOKEN ?? ""
}
