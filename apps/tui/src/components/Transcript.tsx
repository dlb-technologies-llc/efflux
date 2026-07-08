import { Box, Static, Text } from "ink"
import type { ToolEvent } from "./ToolFrame.tsx"
import { ToolFrame } from "./ToolFrame.tsx"

export type TranscriptEntry =
  | { readonly kind: "message"; readonly role: "user" | "assistant"; readonly content: string }
  | { readonly kind: "tool"; readonly event: ToolEvent }
  | { readonly kind: "info"; readonly text: string }
  | { readonly kind: "error"; readonly text: string }

function Entry({ entry }: { readonly entry: TranscriptEntry }) {
  switch (entry.kind) {
    case "message":
      return (
        <Text>
          <Text bold color={entry.role === "user" ? "cyan" : "magenta"}>
            {entry.role === "user" ? "you" : "assistant"}
          </Text>
          {" "}
          {entry.content}
        </Text>
      )
    case "tool":
      return <ToolFrame event={entry.event} />
    case "info":
      return <Text dimColor>{entry.text}</Text>
    case "error":
      return <Text color="red">{entry.text}</Text>
  }
}

/**
 * Finalized transcript entries render inside `<Static>` so Ink writes them
 * once and they survive in terminal scrollback; only the live region below
 * re-renders per delta.
 */
export function Transcript({ entries }: { readonly entries: ReadonlyArray<TranscriptEntry> }) {
  return (
    <Static items={[...entries]}>
      {(entry, index) => (
        <Box key={index} marginBottom={entry.kind === "message" ? 1 : 0}>
          <Entry entry={entry} />
        </Box>
      )}
    </Static>
  )
}
