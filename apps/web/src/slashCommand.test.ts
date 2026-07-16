/**
 * Ground-truth pins for the pure slash-command helpers in `./slashCommand.ts`.
 *
 * `activeSlashToken` drives the composer autocomplete: given the input text and
 * the caret offset it returns the partial skill token being typed at the caret,
 * or `null` when the caret is not inside a word-boundary `/token`.
 *
 * `skillFromMessage` decides which skill overlay a verbatim message invokes: the
 * first word-boundary `/name` matching a known skill, resolved to the canonical
 * name. The `/name` text is never stripped — these pins prove detection only.
 *
 * @module
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { activeSlashToken, skillFromMessage } from "./slashCommand.ts"

const tokenCases: ReadonlyArray<{
  readonly text: string
  readonly cursor: number
  readonly expected: string | null
}> = [
  { text: "", cursor: 0, expected: null },
  { text: "/", cursor: 1, expected: "" },
  { text: "/brai", cursor: 5, expected: "brai" },
  { text: "/brainstorm", cursor: 11, expected: "brainstorm" },
  { text: "help me /brai", cursor: 13, expected: "brai" },
  { text: "help me /brainstorm ", cursor: 20, expected: null },
  { text: "help me /brainstorm", cursor: 19, expected: "brainstorm" },
  { text: "and/or", cursor: 6, expected: null },
  { text: "http://x", cursor: 8, expected: null },
  { text: "hello", cursor: 5, expected: null },
  { text: "/brai more", cursor: 5, expected: "brai" },
  { text: "/brai more", cursor: 10, expected: null },
]

describe("activeSlashToken", () => {
  for (const { text, cursor, expected } of tokenCases) {
    it.effect(`${JSON.stringify(text)}@${cursor} -> ${JSON.stringify(expected)}`, () =>
      Effect.sync(() => expect(activeSlashToken(text, cursor)).toBe(expected)))
  }
})

const known: ReadonlyArray<string> = ["brainstorm", "summarize", "support"]

const skillCases: ReadonlyArray<{
  readonly message: string
  readonly names: ReadonlyArray<string>
  readonly expected: string | undefined
}> = [
  { message: "help me /brainstorm ideas about carrots", names: known, expected: "brainstorm" },
  { message: "/support please", names: known, expected: "support" },
  { message: "compare /brainstorm and /summarize", names: known, expected: "brainstorm" },
  { message: "just a normal message", names: known, expected: undefined },
  { message: "check the /unknown thing", names: known, expected: undefined },
  { message: "see and/or maybe", names: known, expected: undefined },
  { message: "SILLY /BRAINSTORM caps", names: known, expected: "brainstorm" },
  { message: "path /usr/bin somewhere", names: known, expected: undefined },
  { message: "", names: known, expected: undefined },
  { message: "/brainstorm", names: known, expected: "brainstorm" },
  { message: "/support anything", names: [], expected: undefined },
]

describe("skillFromMessage", () => {
  for (const { message, names, expected } of skillCases) {
    it.effect(`${JSON.stringify(message)} -> ${JSON.stringify(expected)}`, () =>
      Effect.sync(() => expect(skillFromMessage(message, names)).toBe(expected)))
  }
})
