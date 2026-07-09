/** Format a USD cost from OpenRouter accounting; sub-cent turns keep 4 decimals so $0.0001 stays legible. */
export const formatUsd = (cost: number): string =>
  cost >= 0.01 ? `$${cost.toFixed(2)}` : `$${cost.toFixed(4)}`

/** Compact token count, e.g. 1234 -> "1.2k". */
export const formatTokens = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

/** Epoch-ms -> short relative label ("just now", "3m ago", "2h ago", "5d ago"). */
export const formatRelativeTime = (epochMs: number): string => {
  const delta = Date.now() - epochMs
  const mins = Math.floor(delta / 60_000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

/** Compact one-line JSON of decoded tool params (already JSON round-tripped at append time, so `JSON.stringify` never throws); absent params render as their `String` form. */
export const formatParams = (params: unknown): string => JSON.stringify(params) ?? String(params)
