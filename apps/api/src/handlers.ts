import { AgentApi, StreamPart } from "@effect-flue/shared";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import type Agent from "./Agent.ts";

// Per-Agent DurableObjectNamespace stub yielded once at the Worker init
// phase and provided to handlers via this context tag.
export type AgentNamespace = Cloudflare.DurableObjectNamespace<Agent>;

export class AgentStub extends Context.Service<AgentStub, AgentNamespace>()(
  "api/AgentStub",
) {}

const encodeStreamPart = Schema.encodeSync(StreamPart);
const textEncoder = new TextEncoder();

export const AgentHandlers = HttpApiBuilder.group(
  AgentApi,
  "agents",
  (handlers) =>
    handlers
      .handle("prompt", ({ params, payload }) =>
        Effect.gen(function* () {
          const agents = yield* AgentStub;
          const agent = agents.getByName(`${params.name}/${params.id}`);
          return yield* agent.prompt(payload);
        }),
      )
      .handle("history", ({ params }) =>
        Effect.gen(function* () {
          const agents = yield* AgentStub;
          const agent = agents.getByName(`${params.name}/${params.id}`);
          const history = yield* agent.history();
          return { history };
        }),
      )
      .handle("reset", ({ params }) =>
        Effect.gen(function* () {
          const agents = yield* AgentStub;
          const agent = agents.getByName(`${params.name}/${params.id}`);
          yield* agent.reset();
        }),
      )
      .handle("stream", ({ params, payload }) =>
        Effect.gen(function* () {
          const agents = yield* AgentStub;
          const env = yield* Cloudflare.WorkerEnvironment;
          const agent = agents.getByName(`${params.name}/${params.id}`);
          const sseBytes = agent.streamPrompt(payload).pipe(
            Stream.map((part) => {
              const json = JSON.stringify(encodeStreamPart(part));
              return textEncoder.encode(`data: ${json}\n\n`);
            }),
            Stream.provideService(Cloudflare.WorkerEnvironment, env),
          );
          return HttpServerResponse.stream(sseBytes, {
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              connection: "keep-alive",
            },
          });
        }),
      ),
);
