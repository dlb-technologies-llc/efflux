import { readFileSync } from "node:fs"

/** Decode a dotenv value the way wrangler's dotenv does, so a `.dev.vars` value never
 *  derives an FE bearer that mismatches the Worker's own parse: a quote-wrapped value is
 *  the content between the first quote pair (trailing ` # comment` after the close quote
 *  discarded); an unquoted value is truncated at its first `#` (inline comment) and
 *  trimmed. A lone opening quote with no partner is treated as unquoted text. */
const parseValue = (raw: string): string => {
  const first = raw[0]
  if (first === "\"" || first === "'") {
    const close = raw.indexOf(first, 1)
    if (close !== -1) return raw.slice(1, close)
  }
  const hash = raw.indexOf("#")
  return (hash === -1 ? raw : raw.slice(0, hash)).trim()
}

/** Parse dotenv text into a flat map: skips blank and `#`-comment lines, splits each
 *  remaining line on its first `=`, trims the key, and decodes the value via
 *  {@link parseValue} (quote-unwrapping + inline-comment stripping). Later duplicate keys win. */
export const parseDotenv = (text: string): Record<string, string> => {
  const result: Record<string, string> = {}
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim()
    if (line === "" || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    if (key === "") continue
    result[key] = parseValue(line.slice(eq + 1).trim())
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
