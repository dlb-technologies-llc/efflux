/**
 * Tools exposed to the parent prompt loop.
 *
 * Defines two tools the model can call:
 *  - `GetCurrentTime` — no-parameter clock read, returns an ISO 8601 string.
 *  - `SpawnSubagent`  — delegate a focused subtask to a stateless subagent
 *                       (no parent history, returns only final response text).
 *
 * The handlers' R-channel requirements (`LanguageModel | SkillsBucket`, via
 * `runSubagent`) bubble through `AgentToolkit.toLayer(...)` as the layer's
 * `RIn`. They are satisfied at the Worker root by `aiLayer` (Wave 1) and the
 * `SkillsBucket` layer already provided in `Api.ts`.
 *
 * Subagents intentionally have no toolkit attached, so they cannot themselves
 * spawn further subagents — see `runSubagent` for the anti-recursion note.
 */
import { SubagentTaskRequest } from "@effect-flue/shared"
import { Effect, Schema } from "effect"
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai"
import { SkillsBucket } from "./Skills.ts"
import { runSubagent } from "./Subagent.ts"

export const GetCurrentTimeTool = Tool.make("GetCurrentTime", {
  description: "Returns the current UTC date and time as an ISO 8601 string.",
  // No parameters — Tool.make defaults to an empty-object schema (EmptyParams).
  success: Schema.String,
})

// Derive parameters from `SubagentTaskRequest.fields` so the tool surface
// stays in lockstep with the `POST /tasks` HTTP endpoint.
const SpawnSubagentParameters = Schema.Struct(SubagentTaskRequest.fields)

export const SpawnSubagentTool = Tool.make("SpawnSubagent", {
  description:
    "Delegate a focused subtask to a stateless subagent. The subagent has no access to this conversation's history and returns only its final response text. Use for classification, summarization, or KB lookups without polluting the parent's context.",
  parameters: SpawnSubagentParameters,
  success: Schema.String,
  // Declare the services the handler needs at construction time so the
  // handler's R-channel may legally reference them. They bubble up through
  // `AgentToolkit.toLayer(...)` as the layer's `RIn`, where the Worker root
  // satisfies them via `aiLayer` (LanguageModel) and the SkillsBucket layer.
  dependencies: [LanguageModel.LanguageModel, SkillsBucket],
})

export const AgentToolkit = Toolkit.make(GetCurrentTimeTool, SpawnSubagentTool)

export const AgentToolkitLayer = AgentToolkit.toLayer({
  GetCurrentTime: () => Effect.sync(() => new Date().toISOString()),
  SpawnSubagent: (params) =>
    runSubagent({
      prompt: params.prompt,
      ...(params.skill !== undefined ? { skill: params.skill } : {}),
      ...(params.role !== undefined ? { role: params.role } : {}),
      ...(params.model !== undefined ? { model: params.model } : {}),
    }).pipe(
      Effect.map((r) => r.text),
      // Log the typed failure so operators see it in `wrangler tail` even
      // when the model recovers gracefully. Done BEFORE the catch so the
      // log fires regardless of how we choose to surface the error.
      Effect.tapErrorTag("SkillNotFoundError", (e) =>
        Effect.logWarning(`SpawnSubagent: skill not found: ${e.skill}`),
      ),
      Effect.tapErrorTag("RoleNotFoundError", (e) =>
        Effect.logWarning(`SpawnSubagent: role not found: ${e.role}`),
      ),
      Effect.tapErrorTag("AgentError", (e) =>
        Effect.logWarning(`SpawnSubagent: agent error: ${e.message}`),
      ),
      // The Tool.Failure channel is AiError | AiErrorReason by default; we
      // collapse typed Skill/Role-not-found into success-text errors so the
      // model sees the message and can retry/apologize without failing the
      // whole loop. Exhaustive over runSubagent's typed errors via catchTags.
      Effect.catchTags({
        SkillNotFoundError: (e) =>
          Effect.succeed(`Error: Skill not found: ${e.skill}`),
        RoleNotFoundError: (e) =>
          Effect.succeed(`Error: Role not found: ${e.role}`),
        AgentError: (e) => Effect.succeed(`Error: ${e.message}`),
      }),
    ),
})
