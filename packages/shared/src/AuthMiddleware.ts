import { HttpApiMiddleware, HttpApiSecurity } from "effect/unstable/httpapi"
import { ApiToken } from "./ApiToken.ts"

/** Bearer-auth gate tag; the `bearer` scheme decodes `Authorization: Bearer <token>` to a Redacted credential, `requires: ApiToken` is satisfied server-side from the Worker env at request time. The Live rejects by returning a 401 response rather than a typed error member, so the middleware adds nothing to any endpoint's error channel. */
export class AuthMiddleware extends HttpApiMiddleware.Service<AuthMiddleware, { requires: ApiToken }>()(
  "api/AuthMiddleware",
  { security: { bearer: HttpApiSecurity.bearer } },
) {}
