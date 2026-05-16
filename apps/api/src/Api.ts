import { AgentApi } from "@effect-flue/shared"
import * as Cloudflare from "alchemy/Cloudflare"
import { Cause, Effect, Layer, Path, Redacted } from "effect"
import * as Etag from "effect/unstable/http/Etag"
import * as HttpPlatform from "effect/unstable/http/HttpPlatform"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import Agent from "./Agent.ts"
import { AgentHandlers, AgentStub, OpenRouterApiKey } from "./handlers.ts"

const requireEnv = (key: string): string => {
  const value = process.env[key]
  if (value === undefined || value === "") {
    throw new Error(
      `${key} is required (set it in .env before running alchemy deploy)`,
    )
  }
  return value
}

const HttpPlatformStub = Layer.succeed(HttpPlatform.HttpPlatform, {
  fileResponse: () => Effect.die("HttpPlatform.fileResponse not supported"),
  fileWebResponse: () =>
    Effect.die("HttpPlatform.fileWebResponse not supported"),
})

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.filename,
    assets: {
      directory: "./apps/web/dist",
      config: {
        htmlHandling: "auto-trailing-slash",
        notFoundHandling: "single-page-application",
      },
    },
    env: {
      OPENROUTER_API_KEY: Redacted.make(requireEnv("OPENROUTER_API_KEY")),
    },
  },
  Effect.gen(function* () {
    const agents = yield* Agent

    return {
      fetch: HttpApiBuilder.layer(AgentApi).pipe(
        Layer.provide(AgentHandlers),
        Layer.provide([Etag.layer, HttpPlatformStub, Path.layer]),
        HttpRouter.toHttpEffect,
        Effect.map((handler) =>
          Effect.gen(function* () {
            const env = yield* Cloudflare.WorkerEnvironment
            // Worker env binding round-trips through Redacted; unwrap.
            const rawKey = env.OPENROUTER_API_KEY
            const apiKey = Redacted.isRedacted(rawKey)
              ? Redacted.value(rawKey)
              : String(rawKey)
            // HttpApiBuilder deliberately Effect.die's HttpApiSchemaError
            // (request-decode failures) and the encoded result of typed
            // endpoint errors. Those errors implement HttpServerRespondable
            // for a structured response (400 for schema errors, the encoded
            // body for typed errors). We catch the cause here, walk failures
            // and defects, and render the first respondable value found.
            // Without this, request-decode failures surface as CF's generic
            // 500 plain-text rather than the intended 400 JSON.
            return yield* handler.pipe(
              Effect.provideService(AgentStub, agents),
              Effect.provideService(OpenRouterApiKey, apiKey),
              Effect.catchCause((cause) => {
                for (const reason of cause.reasons) {
                  const value = Cause.isFailReason(reason)
                    ? reason.error
                    : Cause.isDieReason(reason)
                      ? reason.defect
                      : undefined
                  if (
                    value !== undefined &&
                    HttpServerRespondable.isRespondable(value)
                  ) {
                    return HttpServerRespondable.toResponse(value)
                  }
                }
                return Effect.logError("Unhandled worker cause", cause).pipe(
                  Effect.as(HttpServerResponse.empty({ status: 500 })),
                )
              }),
            )
          }),
        ),
      ),
    }
  }),
) {}
