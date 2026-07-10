/**
 * Pure row→archive transform: turns the Agent DO's raw journal rows into the
 * encoded {@link SessionArchive} JSON string the DO writes to R2 on close/reap.
 * No I/O — the DO does the SQLite read and the R2 put; this module only shapes
 * the bytes in between.
 *
 * @module
 */
import { JournalEvent, JournalEventPayload, SessionArchive } from "@efflux/shared"
import { Schema } from "effect"

/** Raw journal row as returned by the Agent DO's SQLite (`readJournal` shape). */
export interface JournalRow {
  readonly seq: number
  readonly createdAt: number
  readonly type: string
  readonly payload: string
}

const decodeEventPayload = Schema.decodeUnknownSync(JournalEventPayload)
const encodeArchive = Schema.encodeSync(SessionArchive)

/** Build the encoded archive JSON string from the session's full journal rows. Rows were validated at append time, so decode is total; a corrupt row is a bug and throws. */
export const buildArchive = (input: {
  name: string
  id: string
  closedAt: number
  reason: "closed" | "reaped"
  rows: ReadonlyArray<JournalRow>
}): string => {
  const events = input.rows.map(
    (row) =>
      new JournalEvent({
        seq: row.seq,
        createdAt: row.createdAt,
        event: decodeEventPayload(JSON.parse(row.payload)),
      }),
  )
  const archive = new SessionArchive({
    name: input.name,
    id: input.id,
    closedAt: input.closedAt,
    reason: input.reason,
    events,
  })
  return JSON.stringify(encodeArchive(archive))
}
