import { Cause } from "effect"

/** Best-effort string message from an unknown error-channel value — endpoints like `getSkill`/`approve` carry members without a `message` field, so direct `.message` access is unsafe. */
export const messageOf = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = error.message
    if (typeof message === "string") return message
  }
  return String(error)
}

/** Message from a `Cause`'s first failure reason, falling back when the cause carries only defects/interrupts. */
export const failureMessage = (cause: Cause.Cause<unknown>, fallback: string): string => {
  const failReason = cause.reasons.find(Cause.isFailReason)
  return failReason ? messageOf(failReason.error) : fallback
}
