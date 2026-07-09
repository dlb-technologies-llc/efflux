/**
 * Round-trip characterization of the journal event payloads: encode → decode →
 * re-encode must be stable, proving the codec is total over the values each
 * member admits. This catches Effect-beta shape drift in the embedded `Prompt`
 * parts and pins the codec so W5's `NonNegativeInt` tightening stays green.
 *
 * The clean member schemas — no `SafeName` regex refine, no embedded `Prompt`
 * part — are property-tested through `Schema.toArbitrary`; their `turn`/`hop`/
 * token fields are the `NonNegativeInt`s W5 tightens. The members that embed a
 * `Prompt` part (`tool-call`, `tool-result`, `hop-messages`) and the
 * `user-message` member (whose optional `skill`/`role` carry the `SafeName`
 * regex refine that would exhaust FastCheck's `.filter`) are pinned with fixed
 * representative values built from the real constructors, so a `Prompt`-shape
 * change breaks the test.
 *
 * @module
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Prompt } from "effect/unstable/ai"
import {
  JournalApprovalRequested,
  JournalApprovalResolved,
  JournalAssistantText,
  JournalDone,
  JournalErrorEvent,
  JournalEventPayload,
  JournalHopMessages,
  JournalToolCall,
  JournalToolResult,
  JournalUsage,
  JournalUserMessage,
} from "@effect-flue/shared"

const assertStable = <T, E>(schema: Schema.Codec<T, E>, value: T) =>
  Effect.gen(function* () {
    const encoded = yield* Schema.encodeEffect(schema)(value)
    const decoded = yield* Schema.decodeEffect(schema)(encoded)
    const reEncoded = yield* Schema.encodeEffect(schema)(decoded)
    expect(reEncoded).toStrictEqual(encoded)
  })

const CleanPayload = Schema.Union([
  JournalAssistantText,
  JournalApprovalRequested,
  JournalApprovalResolved,
  JournalUsage,
  JournalDone,
  JournalErrorEvent,
])

const cleanArb = Schema.toArbitrary(CleanPayload)

describe("JournalEventPayload codec", () => {
  it.effect.prop(
    "clean members: encode → decode → re-encode is stable",
    [cleanArb],
    ([payload]) => assertStable(CleanPayload, payload),
    { fastCheck: { numRuns: 100 } },
  )

  it.effect("pins user-message (optional SafeName skill/role)", () =>
    assertStable(
      JournalEventPayload,
      new JournalUserMessage({
        content: "run the build",
        skill: "code-review",
        role: "reviewer",
        model: "openai/gpt-4o-mini",
      }),
    ))

  it.effect("pins tool-call (embeds Prompt.ToolCallPart)", () =>
    assertStable(
      JournalEventPayload,
      new JournalToolCall({
        turn: 1,
        hop: 0,
        part: Prompt.toolCallPart({
          id: "call_1",
          name: "Bash",
          params: { command: "ls -la" },
          providerExecuted: false,
        }),
      }),
    ))

  it.effect("pins tool-result (embeds Prompt.ToolResultPart)", () =>
    assertStable(
      JournalEventPayload,
      new JournalToolResult({
        turn: 1,
        hop: 0,
        part: Prompt.toolResultPart({
          id: "call_1",
          name: "Bash",
          isFailure: false,
          result: { stdout: "total 0", exitCode: 0 },
        }),
      }),
    ))

  it.effect("pins hop-messages (embeds Prompt.Message)", () =>
    assertStable(
      JournalEventPayload,
      new JournalHopMessages({
        turn: 1,
        hop: 0,
        messages: [
          Prompt.userMessage({
            content: [Prompt.textPart({ text: "hello" })],
          }),
          Prompt.assistantMessage({
            content: [Prompt.textPart({ text: "hi there" })],
          }),
        ],
      }),
    ))
})
