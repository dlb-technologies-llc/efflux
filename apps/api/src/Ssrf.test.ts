/**
 * Regression pins for the SSRF host guard (`isBlockedHost`).
 *
 * The blocked table freezes the exact strings the security audit flagged as
 * bypasses: the IPv4-mapped-IPv6 forms (`::ffff:127.0.0.1`, `::ffff:7f00:1`,
 * `::7f00:1`, `::ffff:169.254.169.254`) and the integer/hex-encoded IPv4 forms
 * (`2130706433`, `0x7f000001`) that reach loopback/link-local/private ranges.
 * The allowed table pins genuinely public hosts so a future tightening cannot
 * regress into blocking legitimate egress.
 *
 * Residual, deliberately NOT covered: dotted-octal obfuscation (`0177.0.0.1`)
 * remains a documented gap in the guard, not a pinned vector.
 *
 * @module
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { isBlockedHost } from "./Ssrf.ts"

const blockedVectors: ReadonlyArray<readonly [string, boolean]> = [
  ["localhost", true],
  ["127.0.0.1", true],
  ["10.0.0.5", true],
  ["172.16.0.1", true],
  ["192.168.1.1", true],
  ["169.254.169.254", true],
  ["::1", true],
  ["::ffff:127.0.0.1", true],
  ["::ffff:7f00:1", true],
  ["::ffff:169.254.169.254", true],
  ["::7f00:1", true],
  ["2130706433", true],
  ["0x7f000001", true],
  ["foo.internal", true],
  ["bar.local", true],
  ["", true],
]

const allowedVectors: ReadonlyArray<readonly [string, boolean]> = [
  ["8.8.8.8", false],
  ["1.1.1.1", false],
  ["example.com", false],
  ["api.openrouter.ai", false],
  ["2001:db8::1", false],
]

describe("isBlockedHost", () => {
  for (const [host, expected] of blockedVectors) {
    it.effect(`blocks ${JSON.stringify(host)}`, () =>
      Effect.sync(() => expect(isBlockedHost(host)).toBe(expected)))
  }

  for (const [host, expected] of allowedVectors) {
    it.effect(`allows ${JSON.stringify(host)}`, () =>
      Effect.sync(() => expect(isBlockedHost(host)).toBe(expected)))
  }
})
