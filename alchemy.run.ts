import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import { localState } from "alchemy/State"
import { Effect } from "effect"

import Api from "./apps/api/src/Api.ts"

export default Alchemy.Stack(
  "EffectFlue",
  {
    providers: Cloudflare.providers(),
    state: localState(),
  },
  Effect.gen(function* () {
    const api = yield* Api
    return { url: api.url.as<string>() }
  }),
)
