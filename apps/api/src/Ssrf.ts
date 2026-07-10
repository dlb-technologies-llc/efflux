/** SSRF guard: true when a hostname points at the Worker's own network (localhost, loopback/private/link-local/unique-local literals, IPv4-mapped/compat IPv6, non-dotted integer/hex IP literals, `.internal`/`.local`). Does not stop DNS rebinding or dotted octal/hex octet obfuscation. */
export const isBlockedHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (host === "" || host === "localhost") return true
  if (host.endsWith(".internal") || host.endsWith(".local")) return true
  if (host.includes(":")) {
    if (host === "::1" || host === "::") return true
    if (/^fe[89ab]/.test(host)) return true
    if (/^f[cd]/.test(host)) return true
    const embedded = extractEmbeddedV4(host)
    return embedded !== undefined && isBlockedV4(embedded)
  }
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/.test(host)) return true
  return isBlockedV4(host)
}

/** True when a dotted-quad IPv4 string falls in a loopback/private/link-local range (or `0.0.0.0/8`); non-IPv4 input yields false. */
const isBlockedV4 = (host: string): boolean => {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4 === null) return false
  const a = Number(v4[1])
  const b = Number(v4[2])
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  return false
}

/** Extract the embedded IPv4 from an IPv4-mapped/compat IPv6 literal as a dotted quad; `undefined` when none is present. Handles the dotted tail (`::ffff:127.0.0.1`) and the hex form (`::ffff:7f00:1`, `::7f00:1`). */
const extractEmbeddedV4 = (host: string): string | undefined => {
  const dotted = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host)
  if (dotted !== null) return dotted[1]
  const hex = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host)
  if (hex === null) return undefined
  const high = hex[1]
  const low = hex[2]
  if (high === undefined || low === undefined) return undefined
  const h = Number.parseInt(high, 16)
  const l = Number.parseInt(low, 16)
  return `${h >> 8}.${h & 0xff}.${l >> 8}.${l & 0xff}`
}
