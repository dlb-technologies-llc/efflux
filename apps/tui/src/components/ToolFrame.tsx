import { Text } from "ink"

/** A tool-call or tool-result StreamPart, flattened for transcript rendering. */
export type ToolEvent =
  | { readonly kind: "call"; readonly id: string; readonly name: string; readonly params: unknown }
  | { readonly kind: "result"; readonly id: string; readonly result: unknown; readonly isFailure: boolean }

const MAX_PREVIEW = 120

const preview = (value: unknown): string => {
  const json = JSON.stringify(value) ?? ""
  return json.length > MAX_PREVIEW ? `${json.slice(0, MAX_PREVIEW - 1)}…` : json
}

export function ToolFrame({ event }: { readonly event: ToolEvent }) {
  if (event.kind === "call") {
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
