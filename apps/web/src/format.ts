import type { Message } from "@efflux/shared"

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

/** Compact one-line JSON of decoded tool params (already JSON round-tripped at append time, so `JSON.stringify` never throws); absent params render as the empty string. */
export const formatParams = (params: unknown): string =>
  params === undefined ? "" : (JSON.stringify(params) ?? String(params))

/** Pretty-printed (2-space) JSON of decoded tool params for expanded views; absent params render as the empty string. */
export const prettyParams = (params: unknown): string =>
  params === undefined ? "" : JSON.stringify(params, null, 2)

/**
 * While a load-time `/attach` resume is live, the static `/history` fold still
 * carries the in-flight turn's prompt AND its already-journalled (completed-hop)
 * assistant text — the `/attach` transcript re-renders that turn in full, so
 * rendering both doubles the assistant bubble. This keeps everything up to and
 * INCLUDING the in-flight turn's user prompt and drops that turn's assistant
 * message (there is exactly one per turn), letting the live transcript own the
 * response. Identity when there is no trailing user message to resume from.
 */
export const historyForResume = (messages: ReadonlyArray<Message>): ReadonlyArray<Message> => {
  let lastUser = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message !== undefined && message.role === "user") {
      lastUser = i
      break
    }
  }
  return lastUser === -1 ? messages : messages.slice(0, lastUser + 1)
}
