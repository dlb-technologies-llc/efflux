import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import Api from "./src/Api.ts";
import { OpenRouterKey, Store } from "./src/Secrets.ts";
import { SandboxLive } from "./src/Sandbox.ts";
import { Skills } from "./src/Skills.ts";

export default Alchemy.Stack(
  "EffectFlue",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    yield* Store;
    yield* OpenRouterKey;
    yield* Skills;
    const api = yield* Api;

    return {
      url: api.url.as<string>(),
    };
  }).pipe(Effect.provide(SandboxLive)),
);
