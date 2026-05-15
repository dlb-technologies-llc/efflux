import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import Api from "./apps/api/src/Api.ts";
import { SandboxLive } from "./apps/api/src/Sandbox.ts";
import { OpenRouterKey, Store } from "./apps/api/src/Secrets.ts";
import { Skills } from "./apps/api/src/Skills.ts";

// TODO(assets): Serve the built FE (`./apps/web/dist`) as static assets from
// the same Worker that hosts the HttpApi. The `assets` prop must live in the
// `Cloudflare.Worker<Api>()` props block inside `apps/api/src/Api.ts`
// (the props object is baked into the class at definition time — alchemy's
// Platform constructor does not expose a way to override props at stack
// resolution). Wiring it requires touching `apps/api/src/Api.ts`, which is
// out of scope for this wave. Tried: passing props through the stack via
// `yield*`, using `Api.make()` with extra props — neither path lets the
// stack inject `assets` because the Worker class form takes its props at
// the call site. The FE build artifact at `apps/web/dist/index.html` is
// produced by `pnpm build`; once `assets: "./apps/web/dist"` is added next
// to `main: import.meta.filename` in `apps/api/src/Api.ts`, deploying from
// this stack will upload the dist and serve it alongside `/agents/*`.
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
