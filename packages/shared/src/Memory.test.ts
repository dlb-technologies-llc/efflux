/**
 * Round-trip codec pins for the cross-session memory contract schemas:
 * `MemorySummary` (the prompt-index row), `MemoryEntry` (the full fact),
 * `MemoryListResponse` (the listing envelope), and `PutMemoryRequest`
 * (the size-capped upsert body).
 *
 * All four are pinned with fixed representative values rather than
 * `Schema.toArbitrary` generators: `MemorySummary.name` / `MemoryEntry.name`
 * reach the regex-refined `SafeName` (transitively pulled into
 * `MemoryListResponse` too), which — per the project's Effect-testing
 * convention — exhausts FastCheck's `.filter` if arbitrary-generated, and
 * `PutMemoryRequest` carries plain bound-checked strings where random
 * generation would be noise. Rejections use
 * `Exit.isFailure(Schema.decodeUnknownExit(...))` so a bad input fails
 * without throwing.
 *
 * @module
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Schema } from "effect"
import {
  MemoryEntry,
  MemoryListResponse,
  MemorySummary,
  PutMemoryRequest,
} from "@efflux/shared"

const memorySummaryPins: ReadonlyArray<MemorySummary> = [
  new MemorySummary({
    name: "user-name",
    description: "The user's preferred name",
    updatedAt: 1_700_000_000_000,
  }),
  new MemorySummary({ name: "a", description: "", updatedAt: 0 }),
]

describe("MemorySummary codec", () => {
  memorySummaryPins.forEach((pin, index) => {
    it.effect(`pin ${index} round-trips`, () =>
      Effect.gen(function* () {
        const encoded = yield* Schema.encodeEffect(MemorySummary)(pin)
        const decoded = yield* Schema.decodeEffect(MemorySummary)(encoded)
        const reEncoded = yield* Schema.encodeEffect(MemorySummary)(decoded)
        expect(decoded).toStrictEqual(pin)
        expect(reEncoded).toStrictEqual(encoded)
      }))
  })
})

const memoryEntryPins: ReadonlyArray<MemoryEntry> = [
  new MemoryEntry({
    name: "user-name",
    description: "The user's preferred name",
    content: "The user prefers to be called David.",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
  }),
  new MemoryEntry({
    name: "deploy_notes",
    description: "How this account deploys",
    content: "",
    createdAt: 0,
    updatedAt: 0,
  }),
]

describe("MemoryEntry codec", () => {
  memoryEntryPins.forEach((pin, index) => {
    it.effect(`pin ${index} round-trips`, () =>
      Effect.gen(function* () {
        const encoded = yield* Schema.encodeEffect(MemoryEntry)(pin)
        const decoded = yield* Schema.decodeEffect(MemoryEntry)(encoded)
        const reEncoded = yield* Schema.encodeEffect(MemoryEntry)(decoded)
        expect(decoded).toStrictEqual(pin)
        expect(reEncoded).toStrictEqual(encoded)
      }))
  })
})

const memoryListResponsePins: ReadonlyArray<MemoryListResponse> = [
  new MemoryListResponse({ memories: [] }),
  new MemoryListResponse({
    memories: [
      new MemorySummary({
        name: "user-name",
        description: "The user's preferred name",
        updatedAt: 1_700_000_000_000,
      }),
      new MemorySummary({
        name: "deploy_notes",
        description: "How this account deploys",
        updatedAt: 1_700_000_100_000,
      }),
    ],
  }),
]

describe("MemoryListResponse codec", () => {
  memoryListResponsePins.forEach((pin, index) => {
    it.effect(`pin ${index} round-trips`, () =>
      Effect.gen(function* () {
        const encoded = yield* Schema.encodeEffect(MemoryListResponse)(pin)
        const decoded = yield* Schema.decodeEffect(MemoryListResponse)(encoded)
        const reEncoded = yield* Schema.encodeEffect(MemoryListResponse)(decoded)
        expect(decoded).toStrictEqual(pin)
        expect(reEncoded).toStrictEqual(encoded)
      }))
  })
})

const putMemoryRequestPins: ReadonlyArray<PutMemoryRequest> = [
  new PutMemoryRequest({
    description: "The user's preferred name",
    content: "The user prefers to be called David.",
  }),
  new PutMemoryRequest({
    description: "a".repeat(256),
    content: "b".repeat(16_384),
  }),
]

describe("PutMemoryRequest codec", () => {
  putMemoryRequestPins.forEach((pin, index) => {
    it.effect(`pin ${index} round-trips`, () =>
      Effect.gen(function* () {
        const encoded = yield* Schema.encodeEffect(PutMemoryRequest)(pin)
        const decoded = yield* Schema.decodeEffect(PutMemoryRequest)(encoded)
        const reEncoded = yield* Schema.encodeEffect(PutMemoryRequest)(decoded)
        expect(decoded).toStrictEqual(pin)
        expect(reEncoded).toStrictEqual(encoded)
      }))
  })
})

describe("Memory decode rejections", () => {
  it.effect("rejects an unsafe memory name without throwing", () =>
    Effect.sync(() =>
      expect(
        Exit.isFailure(
          Schema.decodeUnknownExit(MemorySummary)({
            name: "Bad Name!",
            description: "d",
            updatedAt: 0,
          }),
        ),
      ).toBe(true)))

  it.effect("rejects an over-256-char description without throwing", () =>
    Effect.sync(() =>
      expect(
        Exit.isFailure(
          Schema.decodeUnknownExit(PutMemoryRequest)({
            description: "a".repeat(257),
            content: "c",
          }),
        ),
      ).toBe(true)))
})
