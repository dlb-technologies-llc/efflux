/**
 * OpenTelemetry tracing wired the Effect way: an `OtelTracer`-backed Effect
 * `Tracer` whose finished spans are exported to the console, plus `traceTool`
 * for naming individual tool executions.
 *
 * Uses the runtime-neutral `BasicTracerProvider` (no Node `async_hooks`, no
 * browser `window`) so the layer boots under the Workers runtime. The Effect
 * `OtelTracer` bridge drives OpenTelemetry context from the fiber's current
 * span, so no OpenTelemetry `ContextManager` is required.
 */
import * as OtelTracer from "@effect/opentelemetry/OtelTracer"
import * as Resource from "@effect/opentelemetry/Resource"
import {
  BasicTracerProvider,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { Effect, Layer } from "effect"

/**
 * Build the OpenTelemetry `TracerProvider` from the Effect `Resource`, exporting finished spans to
 * the console. `SimpleSpanProcessor` flushes on every `span.end()`, so the provider needs no
 * `shutdown`/`forceFlush` finalizer — a batching or OTLP processor WOULD, or spans buffered at
 * isolate teardown are lost.
 */
const OtelTracerProviderLive = Layer.effect(
  OtelTracer.OtelTracerProvider,
  Effect.gen(function* () {
    const resource = yield* Resource.Resource
    return new BasicTracerProvider({
      resource,
      spanProcessors: [new SimpleSpanProcessor(new ConsoleSpanExporter())],
    })
  }),
)

/** Installs the Effect `Tracer` backed by OpenTelemetry with a console span exporter. Provide once per isolate. */
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
