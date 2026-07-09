import { AgentApi, ToolInfo, ToolsResponse } from "@effect-flue/shared"
import { Effect } from "effect"
import { Tool } from "effect/unstable/ai"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { AgentToolkit } from "./Tools.ts"

/** Read-only toolkit introspection: name, description, and parameters JSON Schema for every tool in AgentToolkit. */
export const MetaHandlers = HttpApiBuilder.group(AgentApi, "meta", (handlers) =>
  handlers.handle("tools", () =>
    Effect.sync(
      () =>
        new ToolsResponse({
          tools: Object.values(AgentToolkit.tools).map(
            (tool) =>
              new ToolInfo({
                name: tool.name,
                description: tool.description ?? "",
                parameters: Tool.getJsonSchema(tool),
              }),
          ),
        }),
    ),
  ),
)
