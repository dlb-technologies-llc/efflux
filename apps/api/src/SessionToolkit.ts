/**
 * Fold the session's resolved `mcpServers` into ONE merged toolkit + handler
 * layer for the turn drivers.
 *
 * Each server is connected and its `tools/list` discovered in parallel; every
 * discovered tool becomes a namespaced dynamic tool (`mcp__<server>__<tool>`)
 * whose handler proxies `tools/call` on that server's connected client. The
 * built toolkit and layer are always merged onto the local `AgentToolkit` /
 * `AgentToolkitLayer` — an empty server list yields a faithful clone with no
 * network calls, so drivers get a single, stable return shape either way.
 */
import { resolveRule, type McpServer } from "@effect-flue/shared"
import { Effect, Layer, Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import { connect, type McpToolDef } from "./Mcp.ts"
import { AgentToolkit, AgentToolkitLayer, ApprovalRules } from "./Tools.ts"

/** Cap on a single MCP tool result — it feeds back into the prompt next hop, so a runaway result must not dwarf the context. */
const MAX_MCP_RESULT_CHARS = 30_000

/** Compose the reserved namespaced tool name for a server tool (`mcp__<server>__<tool>`). */
const mcpToolName = (server: string, tool: string): string => `mcp__${server}__${tool}`

/** Coerce a namespaced name to the provider's `^[A-Za-z0-9_-]{1,64}$` tool-name grammar (disallowed chars → `_`, truncated to 64). */
const sanitizeToolName = (name: string): string =>
  name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64)

/** Narrow an unknown MCP `inputSchema` to a JSON Schema object; primitives/null are treated as "no parameters". */
const isJsonSchema = (value: unknown): value is { [x: string]: unknown } =>
  typeof value === "object" && value !== null

/** Clamp a tool result to MAX_MCP_RESULT_CHARS so one oversized payload can't dominate the next hop. */
const capResult = (text: string): string =>
  text.length > MAX_MCP_RESULT_CHARS
    ? `${text.slice(0, MAX_MCP_RESULT_CHARS)}\n[output truncated]`
    : text

/** De-dupe servers by name (last configured wins), preserving first-seen order. */
const dedupeServers = (servers: ReadonlyArray<McpServer>): Array<McpServer> => {
  const byName = new Map<string, McpServer>()
  for (const server of servers) {
    byName.set(server.name, server)
  }
  return Array.from(byName.values())
}

/**
 * Connect to one server and list its tools, bounded by a timeout; any failure
 * (SSRF reject, handshake error, dead/slow server) collapses to a warning plus
 * an empty tool set so a broken server can never fail the whole build.
 */
const discoverServer = (server: McpServer) =>
  connect(server).pipe(
    Effect.flatMap((client) =>
      client.listTools.pipe(Effect.map((tools) => ({ server, client, tools }))),
    ),
    Effect.timeout("15 seconds"),
    Effect.catchCause((cause) =>
      Effect.logWarning(`MCP discovery failed for server "${server.name}"`, cause).pipe(
        Effect.as({ server, client: undefined, tools: [] }),
      ),
    ),
  )

/** Build the namespaced dynamic tool for one discovered MCP tool; approval is resolved per-call from the request-scoped rules. */
const buildDynamicTool = (namespaced: string, def: McpToolDef) =>
  Tool.dynamic(namespaced, {
    description: def.description,
    parameters: isJsonSchema(def.inputSchema) ? def.inputSchema : undefined,
    success: Schema.String,
    needsApproval: () =>
      Effect.gen(function* () {
        const rules = yield* ApprovalRules
        return resolveRule(rules, namespaced) === "ask"
      }),
  }).annotate(Tool.Strict, false)

/** The dynamic tool instance type — reused to type the tools array so the instances stay identical for `Toolkit.make` and `.toLayer`. */
type McpTool = ReturnType<typeof buildDynamicTool>

/**
 * Discover every resolved server's tools and fold them into the local toolkit.
 *
 * Returns the merged toolkit and merged handler layer. Never fails: per-server
 * failures are caught in `discoverServer`. The empty-server case still routes
 * through `Toolkit.merge` / `Layer.merge` (over an empty dynamic toolkit) so the
 * return type never unions two shapes.
 */
export const buildSessionToolkit = (mcpServers: ReadonlyArray<McpServer>) =>
  Effect.gen(function* () {
    const discovered = yield* Effect.forEach(dedupeServers(mcpServers), discoverServer, {
      concurrency: "unbounded",
    })

    const tools: Array<McpTool> = []
    const handlers: Record<string, (params: unknown) => Effect.Effect<string>> = {}
    const seen = new Set<string>()

    for (const entry of discovered) {
      const client = entry.client
      if (client === undefined) continue
      for (const def of entry.tools) {
        const namespaced = sanitizeToolName(mcpToolName(entry.server.name, def.name))
        if (seen.has(namespaced)) {
          yield* Effect.logWarning(
            `Skipping duplicate MCP tool "${namespaced}" from server "${entry.server.name}"`,
          )
          continue
        }
        seen.add(namespaced)
        const dyn = buildDynamicTool(namespaced, def)
        tools.push(dyn)
        handlers[dyn.name] = (params) =>
          Effect.gen(function* () {
            const rules = yield* ApprovalRules
            if (resolveRule(rules, namespaced) === "deny") {
              return `Error: tool "${namespaced}" is denied by session policy`
            }
            const { text, isError } = yield* client.callTool(def.name, params)
            return capResult(isError ? `Error: ${text}` : text)
          }).pipe(
            Effect.catchTag("McpError", (error) => Effect.succeed(`Error: ${error.message}`)),
          )
      }
    }

    const mcpToolkit = Toolkit.make(...tools)
    return {
      toolkit: Toolkit.merge(AgentToolkit, mcpToolkit),
      toolLayer: Layer.merge(AgentToolkitLayer, mcpToolkit.toLayer(handlers)),
    }
  })

/** The merged `{ toolkit, toolLayer }` bundle — drivers type their inputs off `SessionToolkit["toolkit"]` / `["toolLayer"]`. */
export type SessionToolkit = Effect.Success<ReturnType<typeof buildSessionToolkit>>
