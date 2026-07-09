import { Cause, Schema } from "effect"
import { NonNegativeInt } from "./Schemas.ts"

export class AgentError extends Schema.TaggedErrorClass<AgentError>()(
  "AgentError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 500 },
) {}

export class SkillNotFoundError extends Schema.TaggedErrorClass<SkillNotFoundError>()(
  "SkillNotFoundError",
  {
    skill: Schema.String,
    key: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class RoleNotFoundError extends Schema.TaggedErrorClass<RoleNotFoundError>()(
  "RoleNotFoundError",
  {
    role: Schema.String,
    key: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class ApprovalNotFoundError extends Schema.TaggedErrorClass<ApprovalNotFoundError>()(
  "ApprovalNotFoundError",
  {
    eventId: NonNegativeInt,
  },
  { httpApiStatus: 404 },
) {}

export class ApprovalConflictError extends Schema.TaggedErrorClass<ApprovalConflictError>()(
  "ApprovalConflictError",
  {
    eventId: NonNegativeInt,
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {}

/** Best-effort string message from an unknown error-channel value — many endpoint error members carry no `message` field, so direct `.message` access is unsafe. */
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
