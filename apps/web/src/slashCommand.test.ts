/**
 * Ground-truth pins for the pure slash-command parser in `./slashCommand.ts`.
 *
 * `activeSlashToken` and `parseSlashCommand` are total pure functions with no
 * injected state, so every case is fully deterministic. The tables freeze the
 * EXACT return today so a future edit that changes slash-typing detection or
 * skill resolution breaks a pin instead of silently drifting the composer.
 *
 * The `parseSlashCommand` object pins use `toStrictEqual`, NOT `toEqual`:
 * vitest's `toEqual` ignores keys whose value is `undefined`, so a stray
 * `skill: undefined` on a "no skill" result would slip past `toEqual`.
 *
 * @module
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { activeSlashToken, parseSlashCommand } from "./slashCommand.ts"

const activeSlashTokenCases: ReadonlyArray<readonly [string, string | null]> = [
  ["", null],
  ["/", ""],
  ["/feat", "feat"],
  ["/feature-generating", "feature-generating"],
  ["/feature-generating ", null],
  ["/feature-generating add x", null],
  ["hello", null],
  ["hello /x", null],
  [" /x", null],
]

const knownSkills: ReadonlyArray<string> = ["feature-generating", "support"]

const parseSlashCommandCases: ReadonlyArray<
  readonly [string, ReadonlyArray<string>, { readonly skill?: string; readonly message: string }]
> = [
  ["/feature-generating add dark mode", knownSkills, { skill: "feature-generating", message: "add dark mode" }],
  ["/support help", knownSkills, { skill: "support", message: "help" }],
  ["/feature-generating", knownSkills, { skill: "feature-generating", message: "" }],
  ["/support   ", knownSkills, { skill: "support", message: "" }],
  ["/SUPPORT help", knownSkills, { skill: "support", message: "help" }],
  ["/unknown do thing", knownSkills, { message: "/unknown do thing" }],
  ["hello world", knownSkills, { message: "hello world" }],
  ["/support", [], { message: "/support" }],
  ["", knownSkills, { message: "" }],
]

describe("activeSlashToken", () => {
  for (const [input, expected] of activeSlashTokenCases) {
    it.effect(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () =>
      Effect.sync(() => expect(activeSlashToken(input)).toBe(expected)))
  }
})

describe("parseSlashCommand", () => {
  for (const [input, known, expected] of parseSlashCommandCases) {
    it.effect(`${JSON.stringify(input)} with ${JSON.stringify(known)} -> ${JSON.stringify(expected)}`, () =>
      Effect.sync(() => expect(parseSlashCommand(input, known)).toStrictEqual(expected)))
  }
})
