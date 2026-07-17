/**
 * Contract pins for the workspace-upload schemas: `WorkspaceFilename` (the
 * bare-filename refinement bounding an upload's destination against path
 * traversal) and `UploadResponse` (the landed-path/byte-count confirmation).
 *
 * `WorkspaceFilename` is regex-refined, so — per the project's Effect-testing
 * convention — it is exercised with fixed representative accept/reject values
 * rather than a `Schema.toArbitrary` generator (an arbitrary would exhaust
 * FastCheck's `.filter`). Acceptance uses `Schema.decodeUnknownSync`; rejection
 * uses `Exit.isFailure(Schema.decodeUnknownExit(...))` so a bad input fails
 * without throwing. `UploadResponse` is a plain codec pinned round-trip.
 *
 * @module
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Schema } from "effect"
import { UploadResponse, WorkspaceFilename } from "./Files.ts"

const acceptedFilenames: ReadonlyArray<string> = ["report.pdf", "a", "my-file_1.csv"]

describe("WorkspaceFilename refine", () => {
  acceptedFilenames.forEach((name) => {
    it.effect(`accepts ${name}`, () =>
      Effect.sync(() => expect(Schema.decodeUnknownSync(WorkspaceFilename)(name)).toBe(name)))
  })

  const rejectedFilenames: ReadonlyArray<[string, string]> = [
    ["../escape", "parent-directory traversal"],
    [".hidden", "leading dot"],
    ["has space.txt", "whitespace"],
    ["", "empty string"],
    ["a".repeat(256), "256 chars"],
    ["dir/f.txt", "slash"],
  ]
  rejectedFilenames.forEach(([name, why]) => {
    it.effect(`rejects ${why} without throwing`, () =>
      Effect.sync(() => expect(Exit.isFailure(Schema.decodeUnknownExit(WorkspaceFilename)(name))).toBe(true)))
  })
})

const uploadResponsePins: ReadonlyArray<UploadResponse> = [
  new UploadResponse({ path: "/workspace/report.pdf", bytes: 17 }),
  new UploadResponse({ path: "/workspace/a", bytes: 0 }),
]

describe("UploadResponse codec", () => {
  uploadResponsePins.forEach((pin, index) => {
    it.effect(`pin ${index} round-trips`, () =>
      Effect.sync(() => {
        const encoded = Schema.encodeSync(UploadResponse)(pin)
        const decoded = Schema.decodeUnknownSync(UploadResponse)(encoded)
        expect(decoded).toStrictEqual(pin)
      }))
  })
})
