import { Effect } from "effect"
import { ApiClient, runtime } from "../runtime.ts"

/**
 * Query atom: load the session registry from `GET /agents`. Fires on first
 * subscribe; `useAtomRefresh(sessionsAtom)` re-runs it after a new session is
 * created (a session registers server-side on its first message).
 */
export const sessionsAtom = runtime.atom(
  Effect.fnUntraced(function*() {
    const client = yield* ApiClient
    return yield* client.agents.sessions()
  })(),
)
