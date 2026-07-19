import { AgentApi, ApiToken } from "@efflux/shared"
import * as OpenRouterClient from "@effect/ai-openrouter/OpenRouterClient"
import * as OpenRouterLanguageModel from "@effect/ai-openrouter/OpenRouterLanguageModel"
import { Cause, Context, Effect, FileSystem, Layer, Option, Path, Redacted, Scope } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import * as Etag from "effect/unstable/http/Etag"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as HttpEffect from "effect/unstable/http/HttpEffect"
import * as HttpPlatform from "effect/unstable/http/HttpPlatform"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { DEFAULT_MODEL } from "./Defaults.ts"
import { AgentStub } from "./AgentStub.ts"
import { AgentHandlers } from "./handlers.ts"
import { ArchiveHandlers } from "./ArchiveHandlers.ts"
import { SessionsBucket } from "./ArchiveStore.ts"
import { FilesHandlers } from "./FilesHandlers.ts"
import { OpenAiHandlers } from "./OpenAiHandlers.ts"
import { KnowledgeSearch } from "./Knowledge.ts"
import { KnowledgeHandlers } from "./KnowledgeHandlers.ts"
import { MemoryStub } from "./Memory.ts"
import { MemoryHandlers } from "./MemoryHandlers.ts"
import { MetaHandlers } from "./MetaHandlers.ts"
import { RegistryStub } from "./Registry.ts"
import { ScheduleHandlers } from "./ScheduleHandlers.ts"
import { SecretsHandlers } from "./SecretsHandlers.ts"
import { SkillHandlers } from "./SkillHandlers.ts"
import { TracingLive } from "./Telemetry.ts"
import { AuthMiddlewareLive } from "./AuthMiddleware.ts"
import { SchemaErrorMiddlewareLive } from "./SchemaErrorMiddleware.ts"
import { loadSkillBody, SkillsBucket } from "./Skills.ts"
import { WaitUntil } from "./WaitUntil.ts"

/** DO classes must be re-exported from the Worker entry so the runtime can bind them (wrangler.jsonc: AGENTS→Agent, SANDBOX→Sandbox, REGISTRY→Registry, MEMORY→Memory). */
export { Agent } from "./Agent.ts"
export { Memory } from "./Memory.ts"
export { Registry } from "./Registry.ts"
export { Runner } from "./Runner.ts"
export { Sandbox } from "./Sandbox.ts"

/** Require a non-empty OPENROUTER_API_KEY, throwing a clear error rather than letting an undefined Bearer token reach OpenRouter. */
const requireApiKey = (env: Env): string => {
  const value = env.OPENROUTER_API_KEY
  if (typeof value !== "string" || value === "") {
    throw new Error(
      "OPENROUTER_API_KEY missing from Worker environment (set it via wrangler secret or .dev.vars)",
    )
  }
  return value
}

/** Require a non-empty API_TOKEN, throwing a clear error rather than letting an undefined credential reach the auth gate. */
const requireApiToken = (env: Env): string => {
  const value = env.API_TOKEN
  if (typeof value !== "string" || value === "") {
    throw new Error(
      "API_TOKEN missing from Worker environment (set it via wrangler secret or .dev.vars)",
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

/** Env-independent layer stack, built once per isolate; env-dependent services are provided later from the first request. */
const routerLayer = HttpApiBuilder.layer(AgentApi).pipe(
  Layer.provide(AgentHandlers),
  Layer.provide(SkillHandlers),
  Layer.provide(ArchiveHandlers),
  Layer.provide(OpenAiHandlers),
  Layer.provide(KnowledgeHandlers),
  Layer.provide(MetaHandlers),
  Layer.provide(FilesHandlers),
  Layer.provide(SecretsHandlers),
  Layer.provide(ScheduleHandlers),
  Layer.provide(MemoryHandlers),
  Layer.provide(AuthMiddlewareLive),
  Layer.provide(SchemaErrorMiddlewareLive),
  Layer.provide([
    Etag.layer,
    HttpPlatformStub,
    Path.layer,
    FileSystem.layerNoop({}),
  ]),
)

/** Build the native `(Request, Context<WaitUntil>) => Promise<Response>` handler via effect-smol's web↔Effect boundary; SSE bodies stay streamed. The per-request `WaitUntil` context lets a streaming handler fork the turn driver detached from the request fiber and keep the isolate alive until it completes — workerd fires no disconnect callback, so persistence is inline (not finalizer-driven) and a disconnected turn runs to completion via `ctx.waitUntil`. */
const buildWebHandler = (
  env: Env,
): Promise<
  (request: Request, context: Context.Context<WaitUntil>) => Promise<Response>
> => {
  const scope = Scope.makeUnsafe()
  return Effect.runPromise(
    Effect.gen(function* () {
      const services = Layer.mergeAll(
        makeAiLayer(requireApiKey(env)),
        Layer.succeed(AgentStub, env.AGENTS),
        Layer.succeed(RegistryStub, env.REGISTRY),
        Layer.succeed(MemoryStub, env.MEMORY),
        Layer.succeed(SkillsBucket, env.SKILLS),
        Layer.succeed(SessionsBucket, env.SESSIONS),
        // Local-only: the AI Search binding is removed (see wrangler.jsonc). Provide
        // `Option.none()` so knowledge ops degrade to a clear disabled error; to restore,
        // re-add the binding and swap this back to `Option.some(env.KNOWLEDGE_SEARCH)`.
        Layer.succeed(KnowledgeSearch, Option.none()),
        TracingLive,
      )
      const handler = yield* HttpRouter.toHttpEffect(
        routerLayer.pipe(
          Layer.provide(Layer.succeed(ApiToken, Redacted.make(requireApiToken(env)))),
        ),
      )
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
          return Effect.logError("Unhandled worker cause", cause).pipe(
            Effect.as(
              HttpServerResponse.jsonUnsafe(
                { _tag: "InternalError", message: "internal server error" },
                { status: 500 },
              ),
            ),
          )
        }),
        Effect.withSpan("http.request"),
      )
      const context = yield* Layer.build(services)
      return HttpEffect.toWebHandlerWith<
        | AgentStub
        | RegistryStub
        | MemoryStub
        | SkillsBucket
        | SessionsBucket
        | KnowledgeSearch
        | LanguageModel.LanguageModel,
        | HttpServerRequest.HttpServerRequest
        | Scope.Scope
        | AgentStub
        | RegistryStub
        | MemoryStub
        | SkillsBucket
        | SessionsBucket
        | KnowledgeSearch
        | LanguageModel.LanguageModel
        | WaitUntil
      >(context)(wrapped)
    }).pipe(Effect.provideService(Scope.Scope, scope)),
  )
}

/** Per-isolate handler cache; env is stable for the isolate's lifetime, so build once on the first API request. */
let webHandler:
  | Promise<(request: Request, context: Context.Context<WaitUntil>) => Promise<Response>>
  | undefined

/** MUST stay in exact lockstep with `assets.run_worker_first` in wrangler.jsonc — a path missing there is served the SPA before `fetch` runs. */
const isApiPath = (pathname: string): boolean =>
  pathname === "/agents" ||
  pathname.startsWith("/agents/") ||
  pathname === "/tasks" ||
  pathname.startsWith("/tasks/") ||
  pathname === "/skills" ||
  pathname.startsWith("/skills/") ||
  pathname.startsWith("/v1/") ||
  pathname === "/knowledge" ||
  pathname.startsWith("/knowledge/") ||
  pathname.startsWith("/meta/") ||
  pathname === "/archives" ||
  pathname.startsWith("/archives/") ||
  pathname.startsWith("/memory/")

/** Daily heartbeat cron: exercises the same skill-loading + generateText path the prompt handler uses, against the support skill. */
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
      Effect.provide(makeAiLayer(apiKey)),
    )
    yield* Effect.log(`cron ${controller.cron}: ${response.text}`)
  },
  (effect) =>
    effect.pipe(
      Effect.tapCause((cause) => Effect.logError("cron failed", cause)),
      Effect.catchCause(() => Effect.void),
    ),
)

export default {
  fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url)
    if (!isApiPath(url.pathname)) {
      return env.ASSETS.fetch(request)
    }
    webHandler ??= buildWebHandler(env)
    return webHandler.then(
      (handle) =>
        handle(request, Context.make(WaitUntil, ctx.waitUntil.bind(ctx))),
      (error) => {
        webHandler = undefined
        throw error
      },
    )
  },

  scheduled(controller, env, ctx): void {
    ctx.waitUntil(Effect.runPromise(cronEffect(controller, env)))
  },
} satisfies ExportedHandler<Env>
