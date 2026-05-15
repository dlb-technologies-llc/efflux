import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import Agent from "./Agent.ts";

export class PromptRequest extends Schema.Class<PromptRequest>("PromptRequest")(
  {
    message: Schema.String,
    model: Schema.optionalKey(Schema.String),
    skill: Schema.optionalKey(Schema.String),
  },
) {}

const PromptRequestFromJson = Schema.fromJsonString(PromptRequest);
const decodePromptRequest = Schema.decodeEffect(PromptRequestFromJson);

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.filename },
  Effect.gen(function* () {
    const agents = yield* Agent;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const parts = url.pathname.split("/").filter(Boolean);

        // POST /agents/:name/:id    — send a prompt, returns text
        // GET  /agents/:name/:id    — return session history
        // DELETE /agents/:name/:id  — reset session
        if (parts[0] === "agents" && parts.length === 3) {
          const id = `${parts[1]}/${parts[2]}`;
          const agent = agents.getByName(id);

          if (request.method === "POST") {
            const body = yield* request.text;
            const parsed = yield* decodePromptRequest(body);
            const result = yield* agent.prompt(parsed);
            return yield* HttpServerResponse.json(result);
          }

          if (request.method === "GET") {
            const history = yield* agent.history();
            return yield* HttpServerResponse.json({ history });
          }

          if (request.method === "DELETE") {
            yield* agent.reset();
            return HttpServerResponse.empty({ status: 204 });
          }

          return HttpServerResponse.text("Method not allowed", { status: 405 });
        }

        return HttpServerResponse.text(
          "POST /agents/<name>/<id>  body: { message, model?, skill? }",
          { status: 404 },
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(
            HttpServerResponse.text(`Error: ${cause}`, { status: 500 }),
          ),
        ),
      ),
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
