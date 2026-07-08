import { HttpApiMiddleware } from "effect/unstable/httpapi"

// Schema-error middleware tag — declared in shared so both the API
// definition (which attaches it to `AgentApi`) and the Live transform
// (in apps/api) reference the same service.
//
// We deliberately omit the `error:` option: `layerSchemaErrorTransform`'s
// transform returns `Effect.succeed(HttpServerResponse.jsonUnsafe(...))` directly,
// so the structured 400 body is the response — not a typed error in the
// error channel. Adding `error: CustomError` here would force the transform
// to also accept that error type in its failure channel, which adds noise
// for no behavioral benefit.
export class SchemaErrorMiddleware extends HttpApiMiddleware.Service<SchemaErrorMiddleware>()(
  "api/SchemaErrorMiddleware",
) {}
