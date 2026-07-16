/**
 * WebCrypto AES-GCM helpers for encrypting/decrypting session secrets at
 * rest. The raw key material (`SECRETS_ENCRYPTION_KEY`, a `wrangler secret`)
 * is never used directly as the AES key — it is first hashed through
 * SHA-256 to derive a proper 32-byte key, since AES-GCM-256 requires exactly
 * 32 key bytes and an arbitrary operator-chosen string cannot be trusted to
 * already be that shape (padding/truncating a raw UTF-8 string can split a
 * multi-byte codepoint and silently narrows the effective keyspace).
 *
 * A fresh random 12-byte IV is generated per `encryptSecret` call, per the
 * AES-GCM requirement that an (key, IV) pair is never reused. The IV is
 * returned alongside the ciphertext (both base64) so the caller can persist
 * both and hand them back to `decryptSecret`. AES-GCM's authentication tag
 * means tampered or truncated ciphertext fails decryption rather than
 * silently returning garbage.
 *
 * @module
 */

const IV_BYTES = 12

/** Derive a 32-byte AES-GCM key from arbitrary raw key material via SHA-256. */
const deriveKey = async (rawKey: string): Promise<CryptoKey> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawKey))
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"])
}

/** Base64-encode raw bytes using the standard Web `btoa` global — `apps/api`'s tsconfig has no Node types (`"types": []`), so `Buffer` is unavailable here even though it's runtime-present under `nodejs_compat`. */
export const bytesToBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))

/** Inverse of {@link bytesToBase64}. */
export const base64ToBytes = (base64: string): Uint8Array => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))

/** Encrypt `plaintext` with a key derived from `rawKey`, returning base64 IV + ciphertext. */
export const encryptSecret = async (
  rawKey: string,
  plaintext: string,
): Promise<{ iv: string; ciphertext: string }> => {
  const key = await deriveKey(rawKey)
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext))
  return {
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
  }
}

/** Decrypt a base64 `ciphertext`/`iv` pair produced by `encryptSecret`, recovering the plaintext. */
export const decryptSecret = async (rawKey: string, iv: string, ciphertext: string): Promise<string> => {
  const key = await deriveKey(rawKey)
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(iv) },
    key,
    base64ToBytes(ciphertext),
  )
  return new TextDecoder().decode(decrypted)
}
