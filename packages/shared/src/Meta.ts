import { Schema } from "effect"

/** One tool's public metadata for the Tools panel: name, description, and its parameters rendered as a JSON Schema (opaque display data). */
export class ToolInfo extends Schema.Class<ToolInfo>("ToolInfo")({
  name: Schema.String,
  description: Schema.String,
  parameters: Schema.Unknown,
}) {}

/** The full toolkit inventory returned by GET /meta/tools. */
export class ToolsResponse extends Schema.Class<ToolsResponse>("ToolsResponse")({
  tools: Schema.Array(ToolInfo),
}) {}
