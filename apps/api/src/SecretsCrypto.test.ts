/**
 * Round-trip + tamper pins for the AES-GCM secret encryption helpers.
 * Exercises real WebCrypto calls (no mocking) against fixed representative
 * plaintexts — including one with shell metacharacters, since these values
 * later flow into shell contexts elsewhere in this plan — and pins the two
 * properties that matter most for an at-rest encryption helper: (1) the IV
 * is freshly random per call, so encrypting the same plaintext twice never
 * produces the same ciphertext/IV pair, and (2) tampering with a ciphertext
 * fails the GCM authentication tag rather than silently decrypting to
 * garbage.
 *
 * @module
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { base64ToBytes, bytesToBase64, decryptSecret, encryptSecret } from "./SecretsCrypto.ts"

const rawKey = "test-secrets-encryption-key"

const plaintexts: ReadonlyArray<string> = [
  "sk-abc123plainSecret",
  "",
  "has $variables 'single' \"double\" `backtick` and | pipe && chain",
]

describe("encryptSecret / decryptSecret", () => {
  for (const plaintext of plaintexts) {
    it.effect(`round trips ${JSON.stringify(plaintext)}`, () =>
      Effect.gen(function* () {
        const { iv, ciphertext } = yield* Effect.promise(() => encryptSecret(rawKey, plaintext))
        const decrypted = yield* Effect.promise(() => decryptSecret(rawKey, iv, ciphertext))
        expect(decrypted).toBe(plaintext)
      }))
  }

  it.effect("two encryptions of the same plaintext produce different IV and ciphertext", () =>
    Effect.gen(function* () {
      const a = yield* Effect.promise(() => encryptSecret(rawKey, "same plaintext every time"))
      const b = yield* Effect.promise(() => encryptSecret(rawKey, "same plaintext every time"))
      expect(a.iv).not.toBe(b.iv)
      expect(a.ciphertext).not.toBe(b.ciphertext)
    }))

  it.effect("tampered ciphertext fails the GCM auth tag instead of decrypting to garbage", () =>
    Effect.gen(function* () {
      const { iv, ciphertext } = yield* Effect.promise(() => encryptSecret(rawKey, "authenticate me"))
      const tamperedBytes = base64ToBytes(ciphertext)
      tamperedBytes[0] = (tamperedBytes[0] ?? 0) ^ 0xff
      const tampered = bytesToBase64(tamperedBytes)
      const exit = yield* Effect.tryPromise(() => decryptSecret(rawKey, iv, tampered)).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }))

  it.effect("truncated ciphertext fails the GCM auth tag instead of decrypting to garbage", () =>
    Effect.gen(function* () {
      const { iv, ciphertext } = yield* Effect.promise(() => encryptSecret(rawKey, "authenticate me too"))
      const truncated = bytesToBase64(base64ToBytes(ciphertext).subarray(0, 4))
      const exit = yield* Effect.tryPromise(() => decryptSecret(rawKey, iv, truncated)).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }))
})
