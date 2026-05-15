import { AgentApi } from "@effect-flue/shared";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import Agent from "./Agent.ts";
import { AgentHandlers, AgentStub } from "./handlers.ts";

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.filename },
  Effect.gen(function* () {
    const agents = yield* Agent;

    const AgentStubLive: Layer.Layer<AgentStub> = Layer.succeed(
      AgentStub,
      agents,
    );

    const AppLive = HttpApiBuilder.layer(AgentApi).pipe(
      Layer.provide(AgentHandlers),
      Layer.provide(AgentStubLive),
      Layer.provide(HttpServer.layerServices),
    );

    const { handler } = HttpRouter.toWebHandler(AppLive);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const ctx =
          yield* Effect.context<Cloudflare.WorkerEnvironment | AgentStub>();
        const webRequest = yield* HttpServerRequest.toWeb(request).pipe(
          Effect.orDie,
        );
        const response = yield* Effect.promise(() => handler(webRequest, ctx));
        return HttpServerResponse.fromWeb(response);
      }).pipe(Effect.provideService(AgentStub, agents)),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.R2BucketBindingLive,
        Cloudflare.SecretBindingLive,
      ),
    ),
  ),
) {}
