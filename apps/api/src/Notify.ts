/**
 * Standalone outcome-notification delivery for scheduled-job runs: the pure
 * message formatters shared by the Slack and Email channels, plus best-effort
 * Slack (or generic `{text}` webhook) delivery.
 *
 * This module depends on nothing from the Worker `Env`, `cloudflare:email`, or
 * any other app file — only web-platform globals (`fetch`, `AbortSignal`,
 * `console`, `JSON`). The actual `env.EMAIL.send(...)` call lives in `Agent.ts`;
 * only the pure body/subject builders it needs live here.
 *
 * @module
 */

/**
 * One scheduled-job run's outcome, formatted into a channel message. Plain
 * shape (no Schema.Class) built by the DO; `status` reuses the existing
 * lastRunStatus vocabulary ("ok" / "failed (exit N)").
 */
export type NotifyOutcome = {
  readonly description: string
  readonly status: string
  readonly exitCode: number
  readonly startedAt: number
  readonly finishedAt: number
  readonly stdoutExcerpt: string
  readonly stderrExcerpt: string
}

/** Max chars of a stdout/stderr tail included in any formatted message. */
const OUTPUT_TAIL_MAX = 500

/** Max wall-clock for one outbound notification POST before it aborts. */
const NOTIFY_TIMEOUT_MS = 5000

/** Whole-second run duration derived from the outcome's start/finish timestamps. */
const durationSeconds = (outcome: NotifyOutcome): number =>
  Math.round((outcome.finishedAt - outcome.startedAt) / 1000)

/** Keep only the trailing `OUTPUT_TAIL_MAX` chars of an output excerpt. */
const tail = (text: string): string => (text.length > OUTPUT_TAIL_MAX ? text.slice(-OUTPUT_TAIL_MAX) : text)

/**
 * Compact, readable, multi-line Slack summary: description, status, exit code,
 * run duration in seconds, and a tail of stderr (falling back to stdout when
 * stderr is empty). PURE — no clock, no fetch.
 */
export const formatSlackText = (outcome: NotifyOutcome): string => {
  const primary = outcome.stderrExcerpt.length > 0 ? outcome.stderrExcerpt : outcome.stdoutExcerpt
  const excerpt = tail(primary)
  const lines = [
    `Scheduled job: ${outcome.description}`,
    `Status: ${outcome.status}`,
    `Exit code: ${outcome.exitCode}`,
    `Duration: ${durationSeconds(outcome)}s`,
    excerpt.length > 0 ? `Output:\n${excerpt}` : "Output: (none)",
  ]
  return lines.join("\n")
}

/**
 * Email subject line for a run outcome, e.g. `[efflux] <description> — <status>`.
 * PURE.
 */
export const formatEmailSubject = (outcome: NotifyOutcome): string =>
  `[efflux] ${outcome.description} — ${outcome.status}`

/**
 * Fuller plain-text email body than Slack: labelled sections for
 * status/exit/duration, then both stdout and stderr excerpts (each truncated to
 * `OUTPUT_TAIL_MAX`). PURE.
 */
export const formatEmailText = (outcome: NotifyOutcome): string => {
  const stdout = tail(outcome.stdoutExcerpt)
  const stderr = tail(outcome.stderrExcerpt)
  const lines = [
    `Scheduled job: ${outcome.description}`,
    "",
    `Status: ${outcome.status}`,
    `Exit code: ${outcome.exitCode}`,
    `Duration: ${durationSeconds(outcome)}s`,
    "",
    "stdout:",
    stdout.length > 0 ? stdout : "(none)",
    "",
    "stderr:",
    stderr.length > 0 ? stderr : "(none)",
  ]
  return lines.join("\n")
}

/**
 * Best-effort Slack (or generic `{text}` webhook) delivery: POST the formatted
 * text with a bounded timeout; log a truncated error on a non-2xx, never throw.
 * The Slack URL is user-supplied and this is awaited inside the DO alarm loop,
 * so the timeout keeps a hung endpoint from stalling the alarm.
 */
export const sendSlack = async (webhookUrl: string, outcome: NotifyOutcome): Promise<void> => {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: formatSlackText(outcome) }),
    signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
  })
  if (!response.ok) {
    console.error(`slack notify failed ${response.status}: ${(await response.text()).slice(0, 200)}`)
  }
}
