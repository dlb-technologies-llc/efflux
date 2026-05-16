import { SchemaErrorMiddleware } from "@effect-flue/shared"
import { Effect } from "effect"
import * as SchemaIssue from "effect/SchemaIssue"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { HttpApiMiddleware } from "effect/unstable/httpapi"

// Walk a `SchemaIssue.Issue` tree and surface the first `Pointer`-style path
// it can find. We switch on `_tag` over the full union (Pointer, Composite,
// AnyOf, Filter, Encoding, MissingKey, UnexpectedKey, InvalidType,
// InvalidValue, Forbidden, OneOf) so TypeScript's exhaustiveness check fails
// the build the next time a new `SchemaIssue` member is added upstream —
// rather than silently returning `[]` the way the old duck-typed walker did.
//
// The annotated return type plus a `default`-less `switch` where every case
// `return`s is what enforces exhaustiveness: an unhandled tag would leave a
// code path with no return, which TS rejects.
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

// Live transform for the schema-error middleware. Returns a structured
// 400 JSON body instead of letting `HttpApiBuilder`'s default `Effect.die`
// fall through to the worker's generic 500 path.
//
// Body shape matches the inline `HttpApiSchemaError` discriminant the
// frontend (and any future client) can switch on:
//   { _tag: "HttpApiSchemaError", kind, message, path }
//
// `error.cause` is the `SchemaError` produced by request decoding; its
// `.message` getter delegates to `issue.toString()`, so we get a
// human-readable rendering of the failed parse.
//
// `jsonUnsafe` is used (rather than `json`) because the transform's
// return type forbids the `HttpBodyError` channel that `json` introduces.
// Encoding a small POJO can't fail in practice.
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
