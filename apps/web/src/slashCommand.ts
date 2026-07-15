/**
 * The partial skill-name currently being typed after a leading `/`, or `null`
 * when the composer is not in slash-typing mode — either the input has no
 * leading `/`, or a whitespace character has already ended the token (so the
 * autocomplete should be closed and the rest treated as the message body).
 *
 * `"/"` returns `""` (show every skill); `"/feat"` returns `"feat"`; `"/x "`
 * and `"hello"` and `" /x"` all return `null`.
 */
export const activeSlashToken = (input: string): string | null => {
  if (!input.startsWith("/")) return null
  const rest = input.slice(1)
  if (/\s/.test(rest)) return null
  return rest
}

/**
 * Split a composer input into the skill overlay it selects and the message body
 * to send. A leading `/<token>` whose `<token>` matches a known skill
 * (case-insensitively) resolves to that skill's CANONICAL name and strips the
 * token from the message; anything else — no leading `/`, or a token matching no
 * known skill — is returned verbatim as the message with no skill. The returned
 * `message` is trimmed; callers treat an empty `message` as "nothing to send".
 */
export const parseSlashCommand = (
  input: string,
  knownSkillNames: ReadonlyArray<string>,
): { readonly skill?: string; readonly message: string } => {
  if (!input.startsWith("/")) return { message: input }
  const withoutSlash = input.slice(1)
  const spaceIndex = withoutSlash.search(/\s/)
  const token = spaceIndex === -1 ? withoutSlash : withoutSlash.slice(0, spaceIndex)
  const rest = spaceIndex === -1 ? "" : withoutSlash.slice(spaceIndex + 1)
  const canonical = knownSkillNames.find((name) => name.toLowerCase() === token.toLowerCase())
  if (canonical === undefined) return { message: input }
  return { skill: canonical, message: rest.trim() }
}
