import { HttpApiMiddleware } from "effect/unstable/httpapi"

/** Schema-error middleware tag, declared in shared so the API definition and the Live transform (apps/api) reference one service; no `error:` option — the transform returns the structured 400 response directly rather than a typed error. */
export class SchemaErrorMiddleware extends HttpApiMiddleware.Service<SchemaErrorMiddleware>()(
  "api/SchemaErrorMiddleware",
) {}
