/**
 * OpenTelemetry tracing wired the Effect way: an `OtelTracer`-backed Effect
 * `Tracer` whose finished spans are printed to the console, plus `traceTool`
 * for naming individual tool executions.
 *
 * Uses the runtime-neutral `BasicTracerProvider` (no Node `async_hooks`, no
 * browser `window`) so the layer boots under the Workers runtime. The Effect
 * `OtelTracer` bridge drives OpenTelemetry context from the fiber's current
 * span, so no OpenTelemetry `ContextManager` is required. Spans are printed by a
 * custom `SpanProcessor` using `console.log` — the stock `ConsoleSpanExporter`
 * relies on `console.dir`, which the Workers runtime does not surface.
 */
import * as OtelTracer from "@effect/opentelemetry/OtelTracer"
import * as Resource from "@effect/opentelemetry/Resource"
import { BasicTracerProvider, type SpanProcessor } from "@opentelemetry/sdk-trace-base"
import { Effect, Layer } from "effect"

/**
 * Print each finished span to the console via `console.log` (not `console.dir`, which the Workers
 * runtime does not surface). One line per span carries its name, duration, and trace/span/parent
 * ids; the console is flat, so nesting is recovered by matching `trace` + `parent` across lines.
 * Printing is synchronous on span end, so the provider needs no `shutdown`/`forceFlush` finalizer —
 * a batching or OTLP processor WOULD, or spans buffered at isolate teardown are lost.
 */
const ConsoleSpanProcessor: SpanProcessor = {
  onStart: () => undefined,
  onEnd: (span) => {
    const ctx = span.spanContext()
    const durationMs = span.duration[0] * 1000 + span.duration[1] / 1_000_000
    console.log(
      `[span] ${span.name} dur=${durationMs.toFixed(2)}ms trace=${ctx.traceId} span=${ctx.spanId} parent=${span.parentSpanContext?.spanId ?? "-"}`,
      span.attributes,
    )
  },
  forceFlush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
}

/** Build the OpenTelemetry `TracerProvider` from the Effect `Resource`, printing finished spans to the console. */
const OtelTracerProviderLive = Layer.effect(
  OtelTracer.OtelTracerProvider,
  Effect.gen(function* () {
    const resource = yield* Resource.Resource
    return new BasicTracerProvider({
      resource,
      spanProcessors: [ConsoleSpanProcessor],
    })
  }),
)

/** Installs the Effect `Tracer` backed by OpenTelemetry, printing spans to the console. Provide once per isolate. */
export const TracingLive = OtelTracer.layer.pipe(
  Layer.provide(OtelTracerProviderLive),
  Layer.provideMerge(Resource.layer({ serviceName: "efflux" })),
)

/** Wrap a tool handler's effect so its execution appears as a `tool.<name>` span under the active model-call span. */
export const traceTool = <A, E, R>(
  name: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  effect.pipe(Effect.withSpan(`tool.${name}`, { attributes: { "tool.name": name } }))
