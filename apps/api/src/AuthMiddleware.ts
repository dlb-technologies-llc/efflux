import { AuthMiddleware, ApiToken } from "@effect-flue/shared"
import { Effect, Layer, Redacted } from "effect"
import { HttpServerResponse } from "effect/unstable/http"

/** Length-independent constant-time string compare — never short-circuits, so timing does not leak the token. Exported so T3.8 can unit-test it. */
export const constantTimeEquals = (a: string, b: string): boolean => {
  let diff = a.length ^ b.length
  const max = Math.max(a.length, b.length)
  for (let i = 0; i < max; i++) {
    diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0)
  }
  return diff === 0
}

/** Bearer-auth Live: compare the decoded credential against the configured `ApiToken` in constant time; pass the endpoint through on match, else short-circuit with an empty 401 response. */
export const AuthMiddlewareLive = Layer.succeed(AuthMiddleware)({
  bearer: (httpEffect, { credential }) =>
    Effect.flatMap(ApiToken, (expected) =>
      constantTimeEquals(Redacted.value(credential), Redacted.value(expected))
        ? httpEffect
        : Effect.succeed(HttpServerResponse.empty({ status: 401 }))),
})
