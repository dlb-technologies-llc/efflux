/**
 * Shared building blocks for the two agent-loop drivers in `handlers.ts`
 * (the `prompt` handler's `generateText` for-loop and the `stream`
 * handler's queue-driven forked `streamText` driver).
 *
 * Deliberately NOT a unified loop abstraction: the two drivers differ in
 * shape (pull-one-response vs push-parts-into-a-queue) and forcing one
 * abstraction over both would obscure each. Only the genuinely shared
 * pieces live here: message composition, skill/role overlay loading, the
 * per-request `BashRunner` layer, and the hop-decision policy.
 *
 * `Subagent.ts` intentionally does NOT use any of this — its no-toolkit,
 * no-history, single-shot design is the anti-recursion guard. Do not fold
 * it in.
 */
import { AgentError, JournalErrorEvent } from "@efflux/shared"
import { Cause, Effect, Layer, type Duration } from "effect"
import type { Response as AiResponse } from "effect/unstable/ai"
import type { AgentNamespace } from "./AgentStub.ts"
import { eventJson } from "./JournalWrite.ts"
import { loadRoleBody, loadSkillBody } from "./Skills.ts"
import { BashRunner } from "./Tools.ts"

/**
 * Hop cap for the manual multi-hop tool loop. Effect AI's
 * `generateText`/`streamText` run ONE round per call (model → resolve tool
 * calls → end) and do NOT continue the conversation so the model can react
 * to tool results — both drivers loop until the finish reason is terminal
 * or this cap is hit.
 *
 * NOTE: hitting the cap truncates SILENTLY — the last response is returned
 * as-is with no cap-reached signal to the client. Changing that is a #31
 * decision; both drivers must keep this semantic until then.
 */
export const MAX_TOOL_HOPS = 8

/**
 * The hop-decision rule shared by both drivers: a `"tool-calls"` finish
 * reason means the model is waiting on tool results, so the loop feeds
 * them back and runs another hop. Any other reason is terminal.
 *
 * The stream driver also uses this to suppress intermediate `finish`
 * frames — a finish that continues the loop must not reach the client,
 * so the FE sees exactly ONE `done` frame.
 */
export const shouldContinueToolLoop = (
  reason: AiResponse.FinishReason,
): boolean => reason === "tool-calls"

/**
 * Compose the OpenRouter message array as
 * `[system: skill, system: role?, system: todos?, ...history, user]`.
 * The optional `todos` system message (a `Current task list:` prefix over the
 * current todo list) is injected AFTER skill/role and BEFORE history.
 * System messages are NOT persisted to history — only user + assistant.
 */
export const composeMessages = (input: {
  skillBody: string
  roleBody: string | undefined
  todos?: string
  history: ReadonlyArray<{ role: "user" | "assistant"; content: string }>
  message: string
}): ReadonlyArray<{
  role: "system" | "user" | "assistant"
  content: string
}> => {
  const systemMessages: Array<{ role: "system"; content: string }> = [
    { role: "system", content: input.skillBody },
  ]
  if (input.roleBody !== undefined) systemMessages.push({ role: "system", content: input.roleBody })
  if (input.todos !== undefined) {
    systemMessages.push({ role: "system", content: `Current task list:\n${input.todos}` })
  }
  return [...systemMessages, ...input.history, { role: "user", content: input.message }]
}

/**
 * Resolve skill + optional role bodies from R2. Default skill is
 * `"support"`. Failures surface as typed errors on the endpoint's error
 * channel.
 */
export const loadOverlay = Effect.fn("loadOverlay")(function* (
  skill: string | undefined,
  role: string | undefined,
) {
  const skillBody = yield* loadSkillBody(skill ?? "support")
  const roleBody = role !== undefined ? yield* loadRoleBody(role) : undefined
  return { skillBody, roleBody }
})

/**
 * Per-request `BashRunner` layer bound to one DO instance's `exec` RPC.
 * Provided into the toolkit pipe in each handler to satisfy `BashTool`'s
 * dependency on `BashRunner` without leaking it to the Worker root.
 */
export const makeBashRunnerLayer = (
  exec: (command: string) => Promise<{
    readonly exitCode: number
    readonly stdout: string
    readonly stderr: string
  }>,
): Layer.Layer<BashRunner> =>
  Layer.succeed(
    BashRunner,
    BashRunner.of({
      exec: (command) => Effect.promise(() => exec(command)),
    }),
  )

/** Per-hop wall-clock ceiling for a single model round (inference + this hop's tool calls). */
export const MODEL_HOP_TIMEOUT: Duration.Input = "120 seconds"

/** Best-effort R2 snapshot of the session workspace; a snapshot failure is logged, never propagated. */
export const snapshotWorkspace = (
  agent: ReturnType<AgentNamespace["getByName"]>,
): Effect.Effect<void> =>
  Effect.promise(() => agent.snapshotIfDirty()).pipe(
    Effect.catchCause((cause) => Effect.logError("Workspace snapshot failed", cause)),
    Effect.asVoid,
  )

/** Map a model-hop failure to the drivers' uniform `AgentError`; a per-hop `Effect.timeout` surfaces as a timeout message (a bare `TimeoutError` carries no `.message`). */
export const toAgentError =
  (context: string) =>
  (error: unknown): Effect.Effect<never, AgentError> =>
    Effect.fail(
      new AgentError({
        message: Cause.isTimeoutError(error)
          ? `${context} timed out`
          : error instanceof Error
            ? error.message
            : `${context} failed: ${String(error)}`,
      }),
    )

/** Append a terminal `JournalError` for a turn from a failure cause; its own append failure is swallowed. */
export const journalTurnError =
  (agent: ReturnType<AgentNamespace["getByName"]>, turn: number) =>
  (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
    Effect.promise(() =>
      agent.appendEvents([eventJson(new JournalErrorEvent({ turn, message: Cause.pretty(cause) }))]),
    ).pipe(Effect.catchCause(() => Effect.void))
