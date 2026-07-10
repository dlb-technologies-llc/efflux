import { SchemaErrorMiddleware } from "@efflux/shared"
import { Effect } from "effect"
import type * as SchemaIssue from "effect/SchemaIssue"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { HttpApiMiddleware } from "effect/unstable/httpapi"

/** Walk a SchemaIssue tree and return the first Pointer-style path; the exhaustive default-less switch makes TS fail the build when a new SchemaIssue member is added upstream. */
const findFirstPath = (issue: SchemaIssue.Issue): ReadonlyArray<PropertyKey> => {
  switch (issue._tag) {
    case "Pointer": {
      const nested = findFirstPath(issue.issue)
      return [...issue.path, ...nested]
    }
    case "Composite":
    case "AnyOf": {
      for (const child of issue.issues) {
        const childPath = findFirstPath(child)
        if (childPath.length > 0) return childPath
      }
      return []
    }
    case "Filter":
    case "Encoding":
      return findFirstPath(issue.issue)
    case "MissingKey":
    case "UnexpectedKey":
    case "InvalidType":
    case "InvalidValue":
    case "Forbidden":
    case "OneOf":
      return []
  }
}

/** Schema-error middleware transform: return a structured 400 JSON body ({ _tag: "HttpApiSchemaError", kind, message, path }) instead of the default Effect.die → 500. */
export const SchemaErrorMiddlewareLive = HttpApiMiddleware.layerSchemaErrorTransform(
  SchemaErrorMiddleware,
  (error) =>
    Effect.succeed(
      HttpServerResponse.jsonUnsafe(
        {
          _tag: "HttpApiSchemaError",
          kind: error.kind,
          message: error.cause.message,
          path: findFirstPath(error.cause.issue),
        },
        { status: 400 },
      ),
    ),
)
