import { Context } from "effect"
import type { Agent } from "./Agent.ts"

/**
 * Typed handle to the `AGENTS` Durable Object namespace. The `Agent` generic
 * gives `getByName(...)` a typed RPC stub whose methods return `Promise`s;
 * call sites wrap them in `Effect.promise`.
 */
export type AgentNamespace = DurableObjectNamespace<Agent>

/** The per-request `AGENTS` namespace, provided at the Worker root. */
export class AgentStub extends Context.Service<AgentStub, AgentNamespace>()(
  "api/AgentStub",
) {}
