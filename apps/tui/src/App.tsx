import { Box, Text, useApp } from "ink"
import TextInput from "ink-text-input"
import * as React from "react"
import type { AgentClient, PromptOverrides } from "./client.ts"
import { handleCommand } from "./commands.ts"
import type { TranscriptEntry } from "./components/Transcript.tsx"
import { Transcript } from "./components/Transcript.tsx"

export interface AppProps {
  readonly client: AgentClient
  readonly name: string
  readonly id: string
  readonly initialOverrides: PromptOverrides
}

export function App({ client, name, id, initialOverrides }: AppProps) {
  const { exit } = useApp()
  const [entries, setEntries] = React.useState<ReadonlyArray<TranscriptEntry>>([])
  const [input, setInput] = React.useState("")
  const [pending, setPending] = React.useState(false)
  const [streaming, setStreaming] = React.useState("")
  const [overrides, setOverrides] = React.useState<PromptOverrides>(initialOverrides)

  const pushEntry = (entry: TranscriptEntry) => {
    setEntries((prev) => [...prev, entry])
  }

  // Accumulate deltas in a ref so tool frames can flush the text streamed so
  // far into a finalized entry, preserving the arrival order of frames
  // inside one assistant turn.
  const streamRef = React.useRef("")
  const appendDelta = (delta: string) => {
    streamRef.current += delta
    setStreaming(streamRef.current)
  }
  const flushStreaming = () => {
    if (streamRef.current.length === 0) return
    const content = streamRef.current
    streamRef.current = ""
    setStreaming("")
    pushEntry({ kind: "message", role: "assistant", content })
  }

  React.useEffect(() => {
    let cancelled = false
    client
      .history(name, id)
      .then((response) => {
        if (cancelled) return
        setEntries(
          response.history.map((message) => ({
            kind: "message",
            role: message.role,
            content: message.content,
          })),
        )
      })
      .catch(() => {
        if (cancelled) return
        pushEntry({ kind: "info", text: "no history for this session yet" })
      })
    return () => {
      cancelled = true
    }
  }, [client, name, id])

  const runSlashCommand = async (line: string) => {
    const result = handleCommand(line, overrides)
    switch (result.kind) {
      case "set-overrides":
        setOverrides(result.overrides)
        pushEntry({ kind: "info", text: result.note })
        return
      case "note":
        pushEntry({ kind: "info", text: result.note })
        return
      case "reset":
        setPending(true)
        try {
          await client.reset(name, id)
          // Append rather than replace: <Static> is append-only (it can't
          // unprint scrollback), and shrinking the items array would leave
          // this confirmation below Static's internal index — never rendered.
          pushEntry({ kind: "info", text: "session reset — server history cleared" })
        } catch (error) {
          pushEntry({
            kind: "error",
            text: `reset failed: ${error instanceof Error ? error.message : String(error)}`,
          })
        } finally {
          setPending(false)
        }
        return
      case "exit":
        exit()
        return
    }
  }

  const runTurn = async (message: string) => {
    pushEntry({ kind: "message", role: "user", content: message })
    setPending(true)
    streamRef.current = ""
    setStreaming("")
    try {
      for await (const part of client.streamPrompt(name, id, message, overrides)) {
        switch (part._tag) {
          case "text-delta":
            appendDelta(part.delta)
            break
          case "tool-call":
            flushStreaming()
            pushEntry({
              kind: "tool",
              event: { kind: "call", id: part.id, name: part.name, params: part.params },
            })
            break
          case "tool-result":
            flushStreaming()
            pushEntry({
              kind: "tool",
              event: { kind: "result", id: part.id, result: part.result, isFailure: part.isFailure },
            })
            break
          case "done":
            flushStreaming()
            break
          case "error":
            flushStreaming()
            pushEntry({ kind: "error", text: part.message })
            break
        }
      }
      flushStreaming()
    } catch (error) {
      flushStreaming()
      pushEntry({
        kind: "error",
        text: `stream failed: ${error instanceof Error ? error.message : String(error)}`,
      })
    } finally {
      setPending(false)
    }
  }

  const onSubmit = (value: string) => {
    const line = value.trim()
    if (line.length === 0 || pending) return
    setInput("")
    if (line.startsWith("/")) {
      void runSlashCommand(line)
    } else {
      void runTurn(line)
    }
  }

  return (
    <Box flexDirection="column">
      <Transcript entries={entries} />
      {streaming.length > 0 ? (
        <Box marginBottom={1}>
          <Text>
            <Text bold color="magenta">assistant</Text> {streaming}
          </Text>
        </Box>
      ) : null}
      <Box>
        {pending ? (
          <Text dimColor>thinking…</Text>
        ) : (
          <>
            <Text color="cyan">{"> "}</Text>
            <TextInput value={input} onChange={setInput} onSubmit={onSubmit} />
          </>
        )}
      </Box>
      <Text dimColor>
        {name}/{id} · model {overrides.model ?? "(default)"} · /model /skill /role /reset /exit
      </Text>
    </Box>
  )
}
