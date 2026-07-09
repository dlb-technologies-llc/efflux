import { ApprovalDecision, failureMessage } from "@effect-flue/shared"
import type { StreamPart } from "@effect-flue/shared"
import { Effect, Exit, Function, Stream } from "effect"
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

/** Interactive Ink chat: streams turns, handles slash commands, renders the transcript. */
export function App({ client, name, id, initialOverrides }: AppProps) {
  const { exit } = useApp()
  const [entries, setEntries] = React.useState<ReadonlyArray<TranscriptEntry>>([])
  const [input, setInput] = React.useState("")
  const [pending, setPending] = React.useState(false)
  const [streaming, setStreaming] = React.useState("")
  const [overrides, setOverrides] = React.useState<PromptOverrides>(initialOverrides)
  const [pendingApprovalId, setPendingApprovalId] = React.useState<number | null>(null)

  const mountedRef = React.useRef(true)
  React.useEffect(
    () => () => {
      mountedRef.current = false
      void client.runtime.dispose()
    },
    [client],
  )

  const pushEntry = (entry: TranscriptEntry) => {
    setEntries((prev) => [...prev, entry])
  }

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
    client.runtime.runPromiseExit(client.history(name, id)).then((result) => {
      if (!mountedRef.current) return
      Exit.match(result, {
        onSuccess: (response) =>
          setEntries(
            response.history.map((message) => ({
              kind: "message",
              role: message.role,
              content: message.content,
            })),
          ),
        onFailure: () => pushEntry({ kind: "info", text: "no history for this session yet" }),
      })
    })
  }, [client, name, id])

  const onPart = (part: StreamPart) => {
    switch (part._tag) {
      case "text-delta":
        appendDelta(part.delta)
        return
      case "tool-call":
        flushStreaming()
        pushEntry({ kind: "tool", event: part })
        return
      case "tool-result":
        flushStreaming()
        pushEntry({ kind: "tool", event: part })
        return
      case "done":
        flushStreaming()
        return
      case "error":
        flushStreaming()
        pushEntry({ kind: "error", text: part.message })
        return
      case "approval-request":
        flushStreaming()
        setPendingApprovalId(part.eventId)
        pushEntry({ kind: "info", text: "⏸ tool call parked — /approve or /deny [reason]" })
        return
      default:
        return Function.absurd(part)
    }
  }

  const runTurn = async (message: string) => {
    pushEntry({ kind: "message", role: "user", content: message })
    setPending(true)
    streamRef.current = ""
    setStreaming("")
    const result = await client.runtime.runPromiseExit(
      Stream.runForEach(
        client.streamPrompt(name, id, message, overrides),
        (part) => Effect.sync(() => onPart(part)),
      ),
    )
    if (!mountedRef.current) return
    flushStreaming()
    setPending(false)
    if (Exit.isFailure(result)) {
      pushEntry({ kind: "error", text: `stream failed: ${failureMessage(result.cause, "unknown error")}` })
    }
  }

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
      case "approve": {
        if (pendingApprovalId === null) {
          pushEntry({ kind: "info", text: "nothing awaiting approval" })
          return
        }
        const eventId = pendingApprovalId
        const decision = new ApprovalDecision({
          approved: result.approved,
          ...(result.reason !== undefined ? { reason: result.reason } : {}),
        })
        setPendingApprovalId(null)
        setPending(true)
        streamRef.current = ""
        setStreaming("")
        const exitResult = await client.runtime.runPromiseExit(
          Stream.runForEach(
            client.streamApprove(name, id, eventId, decision),
            (part) => Effect.sync(() => onPart(part)),
          ),
        )
        if (!mountedRef.current) return
        flushStreaming()
        setPending(false)
        if (Exit.isFailure(exitResult)) {
          pushEntry({
            kind: "error",
            text: `stream failed: ${failureMessage(exitResult.cause, "unknown error")}`,
          })
        }
        return
      }
      case "reset": {
        setPending(true)
        const exitResult = await client.runtime.runPromiseExit(client.reset(name, id))
        if (!mountedRef.current) return
        setPending(false)
        Exit.match(exitResult, {
          onSuccess: () =>
            pushEntry({ kind: "info", text: "session reset — server history cleared" }),
          onFailure: (cause) => {
            pushEntry({ kind: "error", text: `reset failed: ${failureMessage(cause, "unknown error")}` })
          },
        })
        return
      }
      case "exit":
        exit()
        return
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
