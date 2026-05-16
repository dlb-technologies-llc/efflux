import { AgentApi } from "@effect-flue/shared"
import * as Cloudflare from "alchemy/Cloudflare"
import { Stage } from "alchemy/Stage"
import { Cause, Effect, Layer, Option, Path, Redacted } from "effect"
import * as Etag from "effect/unstable/http/Etag"
import * as HttpPlatform from "effect/unstable/http/HttpPlatform"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import Agent from "./Agent.ts"
import { AgentHandlers, AgentStub, OpenRouterApiKey } from "./handlers.ts"
import { callOpenRouter, DEFAULT_MODEL } from "./OpenRouterClient.ts"
import { SchemaErrorMiddlewareLive } from "./SchemaErrorMiddleware.ts"
import { loadSkillBody, Skills, SkillsBucket } from "./Skills.ts"

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

// `WorkerEnvironment` is only available inside per-event Effects (fetch
// dispatch + cron callback). Yielding it in the outer Worker init crashes
// the Worker with the opaque `[object Object]` failure (see ISSUES.md).
//
// `requireEnv` in the deploy props is the primary guard, but defending the
// runtime path too prevents a silent "undefined" Bearer token from ever
// reaching OpenRouter if a binding round-trip ever drops the value.
const unwrapApiKey = Effect.gen(function* () {
  const env = yield* Cloudflare.WorkerEnvironment
  const raw = env.OPENROUTER_API_KEY
  if (raw === undefined || raw === null || raw === "") {
    return yield* Effect.die(
      new Error("OPENROUTER_API_KEY missing from Worker environment"),
    )
  }
  if (Redacted.isRedacted(raw)) {
    const value = Redacted.value(raw)
    if (typeof value !== "string" || value === "") {
      return yield* Effect.die(
        new Error("OPENROUTER_API_KEY is empty or non-string after unwrap"),
      )
    }
    return value
  }
  if (typeof raw !== "string") {
    return yield* Effect.die(
      new Error(`OPENROUTER_API_KEY has unexpected type: ${typeof raw}`),
    )
  }
  return raw
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
    // Alchemy wrapper client. Resolving its `.raw` (native R2Bucket handle)
    // requires `WorkerEnvironment`, so we defer that to per-event Effects.
    const skillsClient = yield* Cloudflare.R2Bucket.bind(Skills)

    // Daily heartbeat cron — exercises the same skill-loading path the
    // prompt handler uses, against the support skill.
    //
    // Stage gating: `Stage` is provided by alchemy's CLI at DEPLOY time
    // (`alchemy/Cli/commands/deploy.ts` wraps the Stack scope in
    // `Layer.succeed(Stage, stage)`). The Worker init Effect runs in two
    // distinct contexts:
    //
    //   - Deploy time: `Stage` is `Some(<--stage value>)`. We only want to
    //     register the cron trigger on `prod` to avoid dev/staging Workers
    //     firing real OpenRouter calls every 12 minutes.
    //   - Worker runtime (inside Cloudflare): no Stack, no plan phase, and
    //     `Stage` is unset → `None`. `Binding.Policy`'s runtime path treats
    //     `cron(...).subscribe(...)` as a no-op for registration and only
    //     wires the scheduled-event listener. The listener has to run on
    //     every Worker (because the resource for the prod cron trigger
    //     lives in the deployed code), so `onNone` must register too.
    //
    // Net effect:
    //   - prod Worker:    cron trigger created at deploy + handler wired at runtime.
    //   - dev/staging:    no cron trigger and the listener is harmless.
    const stage = yield* Effect.serviceOption(Stage)
    const shouldRegisterCron = Option.match(stage, {
      onNone: () => true,
      onSome: (s) => s === "prod",
    })

    if (shouldRegisterCron) {
      yield* Cloudflare.cron("0 12 * * *").subscribe((controller) =>
        Effect.gen(function* () {
          const apiKey = yield* unwrapApiKey
          const skills = yield* skillsClient.raw
          const skillBody = yield* loadSkillBody("support").pipe(
            Effect.provideService(SkillsBucket, skills),
          )
          const result = yield* callOpenRouter(apiKey, DEFAULT_MODEL, [
            { role: "system", content: skillBody },
            {
              role: "user",
              content:
                "Daily heartbeat. Reply with one short sentence about today.",
            },
          ])
          yield* Effect.log(`cron ${controller.cron}: ${result.text}`)
        }).pipe(
          // `tapCause` BEFORE `catchCause` is load-bearing — without it,
          // transient OpenRouter failures vanish silently.
          Effect.tapCause((cause) => Effect.logError("cron failed", cause)),
          Effect.catchCause(() => Effect.void),
        ),
      )
    }

    return {
      fetch: HttpApiBuilder.layer(AgentApi).pipe(
        Layer.provide(AgentHandlers),
        // Provided ahead of the platform/etag stack so the schema-error
        // transform participates in the request pipeline composed by
        // `HttpApiBuilder.layer` for every endpoint in `AgentApi`.
        Layer.provide(SchemaErrorMiddlewareLive),
        Layer.provide([Etag.layer, HttpPlatformStub, Path.layer]),
        HttpRouter.toHttpEffect,
        Effect.map((handler) =>
          Effect.gen(function* () {
            const apiKey = yield* unwrapApiKey
            const skills = yield* skillsClient.raw
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
              Effect.provideService(SkillsBucket, skills),
              Effect.catchCause((cause) => {
                for (const reason of cause.reasons) {
                  const value = Cause.isFailReason(reason)
                    ? reason.error
                    : Cause.isDieReason(reason)
                      ? reason.defect
                      : undefined
                  if (value === undefined) continue
                  if (HttpServerRespondable.isRespondable(value)) {
                    return HttpServerRespondable.toResponse(value)
                  }
                  // HttpApiBuilder calls JSON.parse synchronously when reading a
                  // Json payload (HttpApiBuilder.ts:557 in effect-smol). A
                  // malformed body throws SyntaxError that becomes a defect, not
                  // a typed HttpApiSchemaError — surface as 400, not 500.
                  if (value instanceof SyntaxError) {
                    return Effect.succeed(
                      HttpServerResponse.empty({ status: 400 }),
                    )
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
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.R2BucketBindingLive,
        Cloudflare.CronEventSourceLive,
      ),
    ),
  ),
) {}
