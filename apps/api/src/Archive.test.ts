/**
 * Pins the pure row→archive transform in {@link buildArchive}. A small
 * hand-built `rows` array — a `user-message`, an `assistant-text`, and the
 * terminal `session-closed` — is encoded exactly as the Agent DO stores rows
 * (each `payload` is `JSON.stringify` of the encoded {@link JournalEventPayload}),
 * then fed through `buildArchive`. The result must `JSON.parse` and decode back
 * through {@link SessionArchive}, preserving event order, count, and tags —
 * proving the transform is total and that the archive-only `session-closed`
 * event survives the round trip.
 *
 * @module
 */
import { describe, expect, it } from "@effect/vitest"
import {
  JournalAssistantText,
  JournalEventPayload,
  JournalSessionClosed,
  JournalUserMessage,
  SessionArchive,
} from "@efflux/shared"
import { Effect, Schema } from "effect"
import { type JournalRow, buildArchive } from "./Archive.ts"

const encodePayload = Schema.encodeSync(JournalEventPayload)
const decodeArchive = Schema.decodeUnknownSync(SessionArchive)

describe("buildArchive", () => {
  it.effect("row→archive round trips through SessionArchive with events intact", () =>
    Effect.sync(() => {
      const rows: ReadonlyArray<JournalRow> = [
        {
          seq: 1,
          createdAt: 1000,
          type: "user-message",
          payload: JSON.stringify(encodePayload(new JournalUserMessage({ content: "list files" }))),
        },
        {
          seq: 2,
          createdAt: 2000,
          type: "assistant-text",
          payload: JSON.stringify(
            encodePayload(new JournalAssistantText({ turn: 1, hop: 0, text: "here are the files" })),
          ),
        },
        {
          seq: 3,
          createdAt: 3000,
          type: "session-closed",
          payload: JSON.stringify(encodePayload(new JournalSessionClosed({ reason: "closed" }))),
        },
      ]

      const json = buildArchive({
        name: "agent",
        id: "sess_1",
        closedAt: 3000,
        reason: "closed",
        rows,
      })

      const archive = decodeArchive(JSON.parse(json))

      expect(archive.name).toBe("agent")
      expect(archive.id).toBe("sess_1")
      expect(archive.closedAt).toBe(3000)
      expect(archive.reason).toBe("closed")
      expect(archive.events).toHaveLength(3)
      expect(archive.events.map((event) => event.seq)).toStrictEqual([1, 2, 3])
      expect(archive.events.map((event) => event.event._tag)).toStrictEqual([
        "user-message",
        "assistant-text",
        "session-closed",
      ])
    }))
})
