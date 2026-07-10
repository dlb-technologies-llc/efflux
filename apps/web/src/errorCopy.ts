import { Cause } from "effect"
import type {
  AgentError,
  ApprovalConflictError,
  ApprovalNotFoundError,
  RoleNotFoundError,
  SkillNotFoundError,
} from "@efflux/shared"
import { failureMessage, messageOf } from "./errors.ts"

/** Title + fix-oriented detail for a UI error surface — never a raw stack. */
export interface ErrorCopy {
  readonly title: string
  readonly detail: string
}

/** The `_tag` literals of the shared tagged errors; renaming a class breaks the `known` keys at compile time. */
type SharedErrorTag = (
  | AgentError
  | SkillNotFoundError
  | RoleNotFoundError
  | ApprovalNotFoundError
  | ApprovalConflictError
)["_tag"]

/** Actionable copy keyed by the shared tagged-error `_tag`; unknown tags fall through to the generic message. */
const known: Partial<Record<SharedErrorTag, ErrorCopy>> = {
  AgentError: {
    title: "The agent run failed",
    detail:
      "The agent hit an error mid-run. Try again, and if it keeps failing switch this session's model or check the worker logs (bun run tail).",
  },
  SkillNotFoundError: {
    title: "Skill not found",
    detail:
      "That skill isn't in the skills bucket. Check the skill name for typos, or upload it with bun scripts/upload-skills.ts.",
  },
  RoleNotFoundError: {
    title: "Role not found",
    detail:
      "That role isn't in the roles bucket. Check the role name against the roles you've uploaded before retrying.",
  },
  ApprovalNotFoundError: {
    title: "Approval no longer available",
    detail:
      "This approval request has already been resolved or has expired. Refresh the session to see its current state.",
  },
  ApprovalConflictError: {
    title: "Approval already decided",
    detail:
      "Someone (or another tab) already approved or denied this request. Refresh the session and try again.",
  },
}

/** The `_tag` of `value` when it is a tagged object, otherwise `undefined`. */
function tagOf(value: unknown): string | undefined {
  if (typeof value === "object" && value !== null && "_tag" in value) {
    const tag = value._tag
    if (typeof tag === "string") return tag
  }
  return undefined
}

/** Walks a `Cause`'s fail reasons (or a bare value) for the first tagged error's `_tag`. */
function findTag(cause: unknown): string | undefined {
  if (Cause.isCause(cause)) {
    for (const reason of cause.reasons) {
      if (Cause.isFailReason(reason)) {
        const tag = tagOf(reason.error)
        if (tag !== undefined) return tag
      }
    }
    return undefined
  }
  return tagOf(cause)
}

const fallbackDetail =
  "An unexpected error occurred. Try again, and check the worker logs (bun run tail) if it keeps happening."

/** Maps an unknown failure `cause` to actionable, human-facing copy, never exposing a raw stack. */
export function errorCopy(cause: unknown): ErrorCopy {
  const tag = findTag(cause)
  if (tag !== undefined) {
    const copy = Object.entries(known).find(([knownTag]) => knownTag === tag)?.[1]
    if (copy !== undefined) return copy
  }
  const detail = Cause.isCause(cause) ? failureMessage(cause, fallbackDetail) : messageOf(cause)
  return { title: "Something went wrong", detail }
}
