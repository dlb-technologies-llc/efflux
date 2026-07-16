/**
 * Round-trip codec pins for the secrets contract schemas: `PutSecretRequest`
 * (the upsert payload), `SecretSummary` (the never-echoes-the-value
 * confirmation), and `SecretListResponse` (the listing envelope).
 *
 * All three are pinned with fixed representative values rather than
 * `Schema.toArbitrary` generators: `PutSecretRequest.value` is a plain
 * bound-checked string, so generating random 4096-char strings would be
 * noise for a bound-check schema; `SecretSummary.name` reaches the
 * regex-refined `SafeName` (transitively pulled into `SecretListResponse`
 * too), which — per the project's Effect-testing convention — exhausts
 * FastCheck's `.filter` if arbitrary-generated, so it is pinned as well.
 *
 * @module
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { PutSecretRequest, SecretListResponse, SecretSummary } from "./Secrets.ts"

const putSecretRequestPins: ReadonlyArray<PutSecretRequest> = [
  new PutSecretRequest({ value: "x" }),
  new PutSecretRequest({ value: "sk-ant-api03-abcdef1234567890" }),
  new PutSecretRequest({ value: "a".repeat(4096) }),
]

describe("PutSecretRequest codec", () => {
  putSecretRequestPins.forEach((pin, index) => {
    it.effect(`pin ${index} round-trips`, () =>
      Effect.sync(() => {
        const encoded = Schema.encodeSync(PutSecretRequest)(pin)
        const decoded = Schema.decodeUnknownSync(PutSecretRequest)(encoded)
        expect(decoded).toStrictEqual(pin)
      }))
  })
})

const secretSummaryPins: ReadonlyArray<SecretSummary> = [
  new SecretSummary({ name: "openrouter-key", createdAt: 0 }),
  new SecretSummary({ name: "stripe-secret", createdAt: 1_700_000_000_000 }),
]

describe("SecretSummary codec", () => {
  secretSummaryPins.forEach((pin, index) => {
    it.effect(`pin ${index} round-trips`, () =>
      Effect.sync(() => {
        const encoded = Schema.encodeSync(SecretSummary)(pin)
        const decoded = Schema.decodeUnknownSync(SecretSummary)(encoded)
        expect(decoded).toStrictEqual(pin)
      }))
  })
})

const secretListResponsePins: ReadonlyArray<SecretListResponse> = [
  new SecretListResponse({ secrets: [] }),
  new SecretListResponse({
    secrets: [
      new SecretSummary({ name: "openrouter-key", createdAt: 1_700_000_000_000 }),
      new SecretSummary({ name: "stripe-secret", createdAt: 1_700_000_100_000 }),
    ],
  }),
]

describe("SecretListResponse codec", () => {
  secretListResponsePins.forEach((pin, index) => {
    it.effect(`pin ${index} round-trips`, () =>
      Effect.sync(() => {
        const encoded = Schema.encodeSync(SecretListResponse)(pin)
        const decoded = Schema.decodeUnknownSync(SecretListResponse)(encoded)
        expect(decoded).toStrictEqual(pin)
      }))
  })
})
