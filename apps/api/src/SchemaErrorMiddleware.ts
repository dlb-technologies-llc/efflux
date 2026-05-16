import { SchemaErrorMiddleware } from "@effect-flue/shared"
import { Effect } from "effect"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { HttpApiMiddleware } from "effect/unstable/httpapi"

// A `PropertyKey` is `string | number | symbol` — exactly what shows up in
// SchemaIssue Pointer `.path` arrays. Narrow at the leaf so the caller
// gets back a clean `ReadonlyArray<PropertyKey>` without any casts.
const isPropertyKey = (value: unknown): value is PropertyKey =>
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "symbol"

const toPathArray = (value: unknown): ReadonlyArray<PropertyKey> => {
  if (!Array.isArray(value)) return []
  const out: Array<PropertyKey> = []
  for (const segment of value) {
    if (!isPropertyKey(segment)) return []
    out.push(segment)
  }
  return out
}

// Walk a `SchemaIssue` tree and surface the first `Pointer`-style path it
// can find. Pointer issues carry a `.path: ReadonlyArray<PropertyKey>`
// segment plus a nested `.issue` for the value at that path. Composite
// issues (Union/Tuple/Struct/Refinement aggregates) carry `.issues: []`.
// We duck-type both shapes (using `in` narrowing — TS keeps the value
// typed as `object` with the probed key) so we are not coupled to
// specific class names, which have changed across pre-release versions
// of effect-smol.
const findFirstPath = (issue: unknown): ReadonlyArray<PropertyKey> => {
  if (issue === null || typeof issue !== "object") return []
  // Pointer-style: direct `.path` array, optionally a nested `.issue`.
  if ("path" in issue) {
    const path = toPathArray(issue.path)
    if (path.length > 0) {
      if ("issue" in issue) {
        const nested = findFirstPath(issue.issue)
        return nested.length > 0 ? [...path, ...nested] : path
      }
      return path
    }
  }
  // Composite-style: walk `.issues` and return the first non-empty path.
  if ("issues" in issue && Array.isArray(issue.issues)) {
    for (const child of issue.issues) {
      const childPath = findFirstPath(child)
      if (childPath.length > 0) return childPath
    }
  }
  return []
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
