/**
 * Round-trips `Message` through encode → decode → re-encode: the encoded form
 * must be stable, proving the codec is total over every value the schema admits.
 *
 * @module
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Message } from "@effect-flue/shared"

const messageArb = Schema.toArbitrary(Message)

describe("Message codec", () => {
  it.effect.prop(
    "encode → decode → re-encode is stable",
    [messageArb],
    ([message]) =>
      Effect.gen(function* () {
        const encoded = yield* Schema.encodeEffect(Message)(message)
        const decoded = yield* Schema.decodeEffect(Message)(encoded)
        const reEncoded = yield* Schema.encodeEffect(Message)(decoded)
        expect(reEncoded).toStrictEqual(encoded)
      }),
    { fastCheck: { numRuns: 100 } },
  )
})
