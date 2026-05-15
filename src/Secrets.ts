import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

export const Store = Cloudflare.SecretsStore("AgentSecrets");

export const OpenRouterKey = Effect.gen(function* () {
  const store = yield* Store;
  const value = yield* Config.redacted("OPENROUTER_API_KEY");
  return yield* Cloudflare.Secret("OpenRouterKey", {
    store,
    value,
  });
}).pipe(Effect.orDie);
