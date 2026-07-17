/**
 * The three #141 metrics, emitted as structured `[metric]` lines to the main
 * Worker log (visible in `bun run tail`, grep `[metric]`) for copy-out into
 * whatever aggregates them. Raw `console.log` — the same mechanism `Telemetry.ts`
 * uses for `[span]` lines, which the Workers runtime surfaces (unlike `console.dir`).
 */
import { Effect } from "effect"

/** One tool invocation with its resolved outcome (ok = useful result, error = crash or error result). */
export const logToolMetric = (tool: string, outcome: "ok" | "error"): Effect.Effect<void> =>
  Effect.sync(() => console.log(`[metric] tool name=${tool} outcome=${outcome}`))

/** One completed turn: wall-clock latency, total OpenRouter cost (USD), tool-call count, keyed by session + model. */
export const logTurnMetric = (fields: {
  readonly sessionId: string
  readonly model: string
  readonly latencyMs: number
  readonly costUsd: number
  readonly toolCalls: number
}): Effect.Effect<void> =>
  Effect.sync(() =>
    console.log(
      `[metric] turn session=${fields.sessionId} model=${fields.model} latency_ms=${Math.round(fields.latencyMs)} cost_usd=${fields.costUsd} tool_calls=${fields.toolCalls}`,
    ),
  )
