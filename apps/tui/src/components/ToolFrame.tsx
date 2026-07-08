import type { StreamPart } from "@effect-flue/shared"
import { Text } from "ink"

/**
 * A tool-call or tool-result event — the tool members of the shared
 * `StreamPart` union itself, not a hand-flattened parallel type.
 */
export type ToolEvent = Extract<StreamPart, { readonly _tag: "tool-call" | "tool-result" }>

const MAX_PREVIEW = 120

const preview = (value: unknown): string => {
  const json = JSON.stringify(value) ?? ""
  return json.length > MAX_PREVIEW ? `${json.slice(0, MAX_PREVIEW - 1)}…` : json
}

export function ToolFrame({ event }: { readonly event: ToolEvent }) {
  if (event._tag === "tool-call") {
    return (
      <Text color="yellow">
        {"  ⚙ "}
        <Text bold>{event.name}</Text> {preview(event.params)}
      </Text>
    )
  }
  return (
    <Text color={event.isFailure ? "red" : "green"}>
      {event.isFailure ? "  ✗ " : "  ✓ "}
      {preview(event.result)}
    </Text>
  )
}
