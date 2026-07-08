import { AgentApi } from "@effect-flue/shared"
import * as OpenRouterClient from "@effect/ai-openrouter/OpenRouterClient"
import * as OpenRouterLanguageModel from "@effect/ai-openrouter/OpenRouterLanguageModel"
import { Cause, Effect, FileSystem, Layer, Path, Redacted, Scope } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import * as Etag from "effect/unstable/http/Etag"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as HttpEffect from "effect/unstable/http/HttpEffect"
import * as HttpPlatform from "effect/unstable/http/HttpPlatform"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { DEFAULT_MODEL } from "./Defaults.ts"
import { AgentHandlers, AgentStub } from "./handlers.ts"
import { RegistryStub } from "./Registry.ts"
import { SchemaErrorMiddlewareLive } from "./SchemaErrorMiddleware.ts"
import { loadSkillBody, SkillsBucket } from "./Skills.ts"

// Durable Object classes must be exported from the Worker entry so the
// runtime can find them (wrangler.jsonc binds AGENTS→Agent, SANDBOX→Sandbox,
// REGISTRY→Registry).
export { Agent } from "./Agent.ts"
export { Registry } from "./Registry.ts"
export { Sandbox } from "./Sandbox.ts"

// `env.OPENROUTER_API_KEY` is a plain string binding. Guard empty/missing
// here — throwing (a defect) with a clear message beats a silent
// "undefined" Bearer token reaching OpenRouter.
const requireApiKey = (env: Env): string => {
  const value = env.OPENROUTER_API_KEY
  if (typeof value !== "string" || value === "") {
    throw new Error(
      "OPENROUTER_API_KEY missing from Worker environment (set it via wrangler secret or .dev.vars)",
    )
  }
  return value
}

const makeAiLayer = (apiKey: string) =>
  OpenRouterLanguageModel.layer({ model: DEFAULT_MODEL }).pipe(
    Layer.provide(OpenRouterClient.layer({ apiKey: Redacted.make(apiKey) })),
    Layer.provide(FetchHttpClient.layer),
  )

const HttpPlatformStub = Layer.succeed(HttpPlatform.HttpPlatform, {
  fileResponse: () => Effect.die("HttpPlatform.fileResponse not supported"),
  fileWebResponse: () =>
    Effect.die("HttpPlatform.fileWebResponse not supported"),
})

// Constant layer stack — built once per isolate. Only the env-dependent
// services (AgentStub, SkillsBucket, the OpenRouter layer) are provided
// later, from the first request's `env`.
const routerLayer = HttpApiBuilder.layer(AgentApi).pipe(
  Layer.provide(AgentHandlers),
  // Provided ahead of the platform/etag stack so the schema-error
  // transform participates in the request pipeline composed by
  // `HttpApiBuilder.layer` for every endpoint in `AgentApi`.
  Layer.provide(SchemaErrorMiddlewareLive),
  // FileSystem is only consumed by HttpApiBuilder's multipart handling,
  // which this API never uses — a noop satisfies the requirement (there is
  // no real filesystem inside a Workers isolate anyway).
  Layer.provide([
    Etag.layer,
    HttpPlatformStub,
    Path.layer,
    FileSystem.layerNoop({}),
  ]),
)

// Build the native `(Request) => Promise<Response>` handler.
//
// `HttpEffect.toWebHandlerWith` is effect-smol's web↔Effect boundary: it
// converts the native `Request` via `HttpServerRequest.fromWeb`, runs the
// handler as a forked fiber, streams the response via
// `HttpServerResponse.toWeb` (Stream bodies stay streams — SSE is not
// buffered), and wires `request.signal` abort to fiber interruption so
// `Stream.ensuring` finalizers in handlers.ts run on client disconnect.
const buildWebHandler = (
  env: Env,
): Promise<(request: Request) => Promise<Response>> => {
  // Layer/handler construction needs a Scope. Workers isolates are never
  // gracefully disposed, so a never-closed module scope is correct here.
  const scope = Scope.makeUnsafe()
  return Effect.runPromise(
    Effect.gen(function* () {
      const services = Layer.mergeAll(
        makeAiLayer(requireApiKey(env)),
        Layer.succeed(AgentStub, env.AGENTS),
        Layer.succeed(RegistryStub, env.REGISTRY),
        Layer.succeed(SkillsBucket, env.SKILLS),
      )
      const handler = yield* HttpRouter.toHttpEffect(routerLayer)
      // HttpApiBuilder deliberately Effect.die's HttpApiSchemaError
      // (request-decode failures) and the encoded result of typed
      // endpoint errors. Those errors implement HttpServerRespondable
      // for a structured response (400 for schema errors, the encoded
      // body for typed errors). We catch the cause here, walk failures
      // and defects, and render the first respondable value found.
      // Without this, request-decode failures surface as CF's generic
      // 500 plain-text rather than the intended 400 JSON.
      const wrapped = handler.pipe(
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
            // a typed HttpApiSchemaError — surface as a structured 400
            // matching `SchemaErrorMiddlewareLive`'s shape, not an empty
            // 400 or a 500.
            if (value instanceof SyntaxError) {
              return Effect.succeed(
                HttpServerResponse.jsonUnsafe(
                  {
                    _tag: "HttpApiSchemaError",
                    kind: "Body",
                    message: value.message,
                    path: [],
                  },
                  { status: 400 },
                ),
              )
            }
          }
          // Infra failures (e.g. a rejecting DO RPC that becomes a defect)
          // land here. Return a STRUCTURED 500 body so clients get a parseable
          // shape, not an empty response; the full cause is logged, and the
          // client-facing message stays generic (no internal leak).
          return Effect.logError("Unhandled worker cause", cause).pipe(
            Effect.as(
              HttpServerResponse.jsonUnsafe(
                { _tag: "InternalError", message: "internal server error" },
                { status: 500 },
              ),
            ),
          )
        }),
      )
      const context = yield* Layer.build(services)
      // `toWebHandlerWith` binds `R` at the first (curried) call, so the
      // handler's requirements must be named explicitly — everything is
      // erased by `context` except the per-request HttpServerRequest/Scope.
      return HttpEffect.toWebHandlerWith<
        AgentStub | RegistryStub | SkillsBucket | LanguageModel.LanguageModel,
        | HttpServerRequest.HttpServerRequest
        | Scope.Scope
        | AgentStub
        | RegistryStub
        | SkillsBucket
        | LanguageModel.LanguageModel
      >(context)(wrapped)
    }).pipe(Effect.provideService(Scope.Scope, scope)),
  )
}

// Per-isolate handler cache. `env` is stable for the isolate's lifetime,
// so building once on the first API request is safe.
let webHandler: Promise<(request: Request) => Promise<Response>> | undefined

const isApiPath = (pathname: string): boolean =>
  pathname === "/agents" ||
  pathname.startsWith("/agents/") ||
  pathname === "/tasks" ||
  pathname.startsWith("/tasks/")

// Daily heartbeat cron — exercises the same skill-loading path the prompt
// handler uses, against the support skill. The trigger is registered
// top-level in wrangler.jsonc.
const cronEffect = Effect.fn("cronHeartbeat")(
  function* (controller: ScheduledController, env: Env) {
    const apiKey = requireApiKey(env)
    const skillBody = yield* loadSkillBody("support").pipe(
      Effect.provideService(SkillsBucket, env.SKILLS),
    )
    const response = yield* LanguageModel.generateText({
      prompt: [
        { role: "system", content: skillBody },
        {
          role: "user",
          content: "Daily heartbeat. Reply with one short sentence about today.",
        },
      ],
    }).pipe(
      // Cron runs outside the per-request handler, so build a fresh AI
      // layer here rather than reusing the request-scoped one.
      Effect.provide(makeAiLayer(apiKey)),
    )
    yield* Effect.log(`cron ${controller.cron}: ${response.text}`)
  },
  // `tapCause` BEFORE `catchCause` is load-bearing — without it,
  // transient OpenRouter failures vanish silently.
  (effect) =>
    effect.pipe(
      Effect.tapCause((cause) => Effect.logError("cron failed", cause)),
      Effect.catchCause(() => Effect.void),
    ),
)

export default {
  fetch(request, env, _ctx): Promise<Response> {
    // Routing FIRST: only API paths reach the HttpApi handler; everything
    // else serves the SPA from static assets. Never "HttpApi 404 → assets"
    // — unknown-skill structured 404s must reach API clients.
    const url = new URL(request.url)
    if (!isApiPath(url.pathname)) {
      return env.ASSETS.fetch(request)
    }
    webHandler ??= buildWebHandler(env)
    return webHandler.then(
      (handle) => handle(request),
      (error) => {
        // Don't poison the isolate with a cached rejected promise — a
        // transient build failure should retry on the next request.
        webHandler = undefined
        throw error
      },
    )
  },

  scheduled(controller, env, ctx): void {
    ctx.waitUntil(Effect.runPromise(cronEffect(controller, env)))
  },
} satisfies ExportedHandler<Env>
