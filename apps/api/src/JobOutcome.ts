import { nextCronOccurrence, type JobRetry } from "@efflux/shared"

/**
 * Pure after-run decision engine for scheduled jobs: ALL post-run
 * scheduling / notification / chain policy lives in this one pure function;
 * the `Agent` DO merely executes its decisions. No I/O, no `Date.now()`
 * (`nowMs` is a parameter), no DO state — kept standalone like
 * `AlarmSchedule.ts` so it is unit-testable without the DO runtime.
 *
 * The decision table (the single source of truth shared with the DO executor):
 *
 * - `failed = exitCode !== 0`.
 * - **retry** when `failed && retry !== undefined && origin !== "manual"
 *   && attemptsUsed + 1 < retry.maxAttempts`: returns
 *   `{ _tag: "retry", nextRunAt: nowMs + retry.backoffSeconds * 1000, attemptsUsed: attemptsUsed + 1 }`.
 *   `maxAttempts` counts TOTAL tries per firing cycle (maxAttempts 3 → try 1
 *   fails (attemptsUsed 0→1), try 2 fails (1→2), try 3 fails → final).
 *   Retries fire via the DO alarm, so a retry run always arrives with origin
 *   `"schedule"` even if the cycle started as `"chain"`. A retry decision
 *   suppresses both notification and chain triggering (the DO only
 *   notifies/chains on `final`). Manual "run now" runs NEVER retry.
 * - **final** otherwise. The `reschedule` member is a function of `origin`
 *   alone (NOT of `attemptsUsed`):
 *   - For `origin === "schedule"` OR `origin === "chain"` — both are "real"
 *     firings that just consumed the current due slot / retry deadline, so
 *     the job's schedule ADVANCES: `cronExpression === ""` → `{ _tag:
 *     "dormant" }` (the executor sets `next_run_at` back to the dormant
 *     sentinel 0); otherwise `nextCronOccurrence(cronExpression, nowMs)` — a
 *     number → `{ _tag: "cron", nextRunAt: <that> }`; `undefined`
 *     (exhausted/impossible schedule) → `{ _tag: "exhausted" }` (executor
 *     deletes the row). A chain trigger advancing the target's schedule is
 *     what prevents a chain target that is ALSO independently cron-due in the
 *     same alarm firing from running twice — the chain run consumes the due
 *     slot, and the alarm loop's per-row re-validation then skips it.
 *   - For `origin === "manual"`: `{ _tag: "keep" }` — a run-now NEVER touches
 *     `next_run_at`, honoring the run-now contract unconditionally. If a
 *     retry was armed, `keep` leaves it armed and it fires on its own
 *     deadline (it is a legitimate pending retry, not a phantom); a manual
 *     run neither advances the cron slot nor cancels a pending retry.
 *   - `chainTargetId = exitCode === 0 ? onSuccessJobId : onFailureJobId`.
 *   - On ANY `final`, the executor resets the persisted attempts counter to
 *     0 (except the `keep` path, which leaves a pending retry cycle intact);
 *     notification fires only on `final` (with the job's own notify filter
 *     still applied by the executor).
 *
 * @module
 */

/**
 * How the run that just completed was started: the DO alarm (`"schedule"` —
 * also every retry run), an explicit run-now (`"manual"`), or a chain trigger
 * from another job's completion (`"chain"`).
 */
export type RunOrigin = "schedule" | "manual" | "chain"

/**
 * What the DO executor must do after a run: arm a retry (suppressing
 * notification and chaining), or finalize the cycle — rescheduling per the
 * `reschedule` member, resetting the attempts counter, notifying, and
 * triggering `chainTargetId` when set.
 */
export type AfterRunDecision =
  | { readonly _tag: "retry"; readonly nextRunAt: number; readonly attemptsUsed: number }
  | {
      readonly _tag: "final"
      readonly reschedule:
        | { readonly _tag: "cron"; readonly nextRunAt: number }
        | { readonly _tag: "dormant" }
        | { readonly _tag: "exhausted" }
        | { readonly _tag: "keep" }
      readonly chainTargetId: string | undefined
    }

/**
 * The `dormant`/`cron`/`exhausted` mapping shared by every schedule- and
 * chain-origin final: empty cron → dormant sentinel, next occurrence → cron,
 * no next occurrence → exhausted.
 */
const rescheduleFromCron = (
  cronExpression: string,
  nowMs: number
):
  | { readonly _tag: "cron"; readonly nextRunAt: number }
  | { readonly _tag: "dormant" }
  | { readonly _tag: "exhausted" } => {
  if (cronExpression === "") return { _tag: "dormant" }
  const next = nextCronOccurrence(cronExpression, nowMs)
  return next === undefined ? { _tag: "exhausted" } : { _tag: "cron", nextRunAt: next }
}

/**
 * Decide what happens after a scheduled-job run completes. Implements the
 * module-level decision table exactly — see the `@module` JSDoc above for
 * the full retry / final semantics. The `reschedule` verdict depends only on
 * `origin` (manual → keep, schedule/chain → advance), never on `attemptsUsed`.
 */
export const decideAfterRun = (input: {
  readonly exitCode: number
  readonly origin: RunOrigin
  readonly cronExpression: string
  readonly retry: JobRetry | undefined
  readonly attemptsUsed: number
  readonly onSuccessJobId: string | undefined
  readonly onFailureJobId: string | undefined
  readonly nowMs: number
}): AfterRunDecision => {
  const failed = input.exitCode !== 0
  if (
    failed &&
    input.retry !== undefined &&
    input.origin !== "manual" &&
    input.attemptsUsed + 1 < input.retry.maxAttempts
  ) {
    return {
      _tag: "retry",
      nextRunAt: input.nowMs + input.retry.backoffSeconds * 1000,
      attemptsUsed: input.attemptsUsed + 1
    }
  }
  const chainTargetId = input.exitCode === 0 ? input.onSuccessJobId : input.onFailureJobId
  if (input.origin === "manual") {
    return { _tag: "final", reschedule: { _tag: "keep" }, chainTargetId }
  }
  return {
    _tag: "final",
    reschedule: rescheduleFromCron(input.cronExpression, input.nowMs),
    chainTargetId
  }
}
