import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import Api from "./apps/api/src/Api.ts";
import { SandboxLive } from "./apps/api/src/Sandbox.ts";
import { OpenRouterKey, Store } from "./apps/api/src/Secrets.ts";
import { Skills } from "./apps/api/src/Skills.ts";

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
