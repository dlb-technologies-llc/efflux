/** SSRF guard: true when a hostname points at the Worker's own network (localhost, loopback/private/link-local/unique-local literals, `.internal`/`.local`). Does not stop DNS rebinding. */
export const isBlockedHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (host === "" || host === "localhost") return true
  if (host.endsWith(".internal") || host.endsWith(".local")) return true
  if (host.includes(":")) {
    if (host === "::1" || host === "::") return true
    if (/^fe[89ab]/.test(host)) return true
    if (/^f[cd]/.test(host)) return true
    return false
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4 !== null) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true
  }
  return false
}
