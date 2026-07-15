/** SafeName charset — a skill token is a `/` followed by one or more of these. */
const TOKEN = "[a-zA-Z0-9_-]"

/** The partial token being typed at the caret (word-boundary `/` + skill chars up to `cursor`). */
const ACTIVE_TOKEN = new RegExp(`(?:^|\\s)/(${TOKEN}*)$`)

/** Every word-boundary `/skill` token in a message, scanned left to right. */
const SKILL_TOKEN = new RegExp(`(?:^|\\s)/(${TOKEN}+)`, "g")

/**
 * The partial skill-name being typed at `cursor` — the run of skill characters
 * immediately before the caret that follows a `/` sitting at a word boundary
 * (start of input or right after whitespace). Returns `null` when the caret is
 * not inside such a token, so the autocomplete stays closed. The word-boundary
 * requirement means `and/or` and `http://x` never open the menu.
 *
 * `("/", 1)` → `""` (show every skill); `("help me /brai", 13)` → `"brai"`;
 * `("help me /brainstorm ", 20)` and `("and/or", 6)` → `null`.
 */
export const activeSlashToken = (text: string, cursor: number): string | null => {
  const match = ACTIVE_TOKEN.exec(text.slice(0, cursor))
  return match?.[1] ?? null
}

/**
 * The first skill invoked inline in `message`: a word-boundary `/<name>` token
 * whose `<name>` matches a known skill (case-insensitively), resolved to the
 * skill's CANONICAL name. `undefined` when the message names no known skill.
 * Only known names match and only at a word boundary, so ordinary `/path`-style
 * text never invokes anything; if several skills are named, the FIRST wins
 * (a turn carries one overlay). The `/<name>` text itself is left in the message
 * verbatim — this only detects which overlay to apply.
 */
export const skillFromMessage = (
  message: string,
  knownSkillNames: ReadonlyArray<string>,
): string | undefined => {
  const canonicalByLower = new Map(knownSkillNames.map((name) => [name.toLowerCase(), name]))
  for (const match of message.matchAll(SKILL_TOKEN)) {
    const token = match[1]
    if (token === undefined) continue
    const canonical = canonicalByLower.get(token.toLowerCase())
    if (canonical !== undefined) return canonical
  }
  return undefined
}
