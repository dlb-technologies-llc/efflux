import { AgentApi } from "@effect-flue/shared"
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect, Layer, Path, Redacted } from "effect"
import * as Etag from "effect/unstable/http/Etag"
import * as HttpPlatform from "effect/unstable/http/HttpPlatform"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
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
            return yield* handler.pipe(
              Effect.provideService(AgentStub, agents),
              Effect.provideService(OpenRouterApiKey, apiKey),
              Effect.orDie,
            )
          }),
        ),
      ),
    }
  }),
) {}
