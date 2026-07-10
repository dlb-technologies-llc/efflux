import { Effect } from "effect"
import type { AgentNamespace } from "./AgentStub.ts"
import { decodeEventPayload } from "./JournalWrite.ts"
import type { ReconstructEvent } from "./Reconstruct.ts"

/** Fully page the session journal into decoded events (oldest first). Decode failures die: rows were validated at append time, so corruption is a bug. */
export const fetchAllEvents = (
  agent: ReturnType<AgentNamespace["getByName"]>,
): Effect.Effect<Array<ReconstructEvent>> =>
  Effect.gen(function* () {
    const events: Array<ReconstructEvent> = []
    let after = 0
    for (;;) {
      const page = yield* Effect.promise(() => agent.readJournal({ after, limit: 500 }))
      for (const row of page.events) {
        const event = yield* decodeEventPayload(JSON.parse(row.payload)).pipe(Effect.orDie)
        events.push({ seq: row.seq, event })
      }
      if (page.nextAfter === null) return events
      after = page.nextAfter
    }
  })
