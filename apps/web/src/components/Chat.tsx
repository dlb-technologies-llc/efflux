import { useAtomRefresh, useAtomSet, useAtomSubscribe, useAtomValue } from "@effect/atom-react"
import type { StreamPart } from "@effect-flue/shared"
import { Cause, Exit } from "effect"
import { AsyncResult } from "effect/unstable/reactivity"
import * as React from "react"
import { historyAtom, streamAtom } from "../atoms.ts"
import { MessageList } from "./MessageList.tsx"

export interface ChatProps {
  readonly name: string
  readonly id: string
}

const noParts: ReadonlyArray<StreamPart> = []

/** Extract a string `message` from the stream's union error channel (not every member carries one). */
const messageOf = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = error.message
    if (typeof message === "string") return message
  }
  return String(error)
}

/** Live chat view: renders session history and streams the current assistant turn. */
export function Chat({ name, id }: ChatProps) {
  const [input, setInput] = React.useState("")
  const [submitError, setSubmitError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)
  const [parts, setParts] = React.useState<ReadonlyArray<StreamPart>>(noParts)

  const sessionAtom = historyAtom({ name, id })
  const historyResult = useAtomValue(sessionAtom)
  const refreshHistory = useAtomRefresh(sessionAtom)
  const runStream = useAtomSet(streamAtom, { mode: "promiseExit" })

  const onResult = React.useCallback(
    (result: AsyncResult.AsyncResult<ReadonlyArray<StreamPart>, unknown>) => {
      if (AsyncResult.isSuccess(result)) setParts(result.value)
    },
    [],
  )
  useAtomSubscribe(streamAtom, onResult)

  const streamingText = parts.reduce(
    (text, part) => (part._tag === "text-delta" ? text + part.delta : text),
    "",
  )
  const toolParts = parts.filter(
    (part) => part._tag === "tool-call" || part._tag === "tool-result",
  )
  const errorPart = parts.find((part) => part._tag === "error")
  const streamError = errorPart !== undefined ? errorPart.message : submitError
  const streamActive = parts.length > 0

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const message = input.trim()
    if (message.length === 0) return
    setParts(noParts)
    setSubmitError(null)
    setInput("")
    setPending(true)
    const exit = await runStream({ name, id, message })
    setPending(false)
    Exit.match(exit, {
      onFailure: (cause) => {
        const failReason = cause.reasons.find(Cause.isFailReason)
        setSubmitError(failReason ? messageOf(failReason.error) : "Stream failed")
        setParts(noParts)
      },
      onSuccess: () => {
        refreshHistory()
      },
    })
  }

  const previousHistoryLengthRef = React.useRef(0)
  React.useEffect(() => {
    if (!AsyncResult.isSuccess(historyResult)) return
    const length = historyResult.value.history.length
    if (length > previousHistoryLengthRef.current && parts.length > 0) {
      setParts(noParts)
    }
    previousHistoryLengthRef.current = length
  }, [historyResult, parts.length])

  return (
    <main className="chat">
      <h1>effect-flue chat</h1>
      <p style={{ opacity: 0.6, fontSize: 13 }}>
        session: <code>{name}/{id}</code>
      </p>
      {AsyncResult.match(historyResult, {
        onInitial: () => <p className="pending">Loading history...</p>,
        onFailure: (failure) => {
          const failReason = failure.cause.reasons.find(Cause.isFailReason)
          return (
            <p className="error">
              Failed to load history:{" "}
              {failReason ? failReason.error.message : "Something went wrong"}
            </p>
          )
        },
        onSuccess: (success) => <MessageList messages={success.value.history} />,
      })}
      {streamActive || pending ? (
        <div className="message message-assistant message-streaming">
          <div className="role">assistant</div>
          {toolParts.map((part, i) =>
            part._tag === "tool-call" ? (
              <div key={`t-${i}`} className="tool-frame tool-running">
                → {part.name}
              </div>
            ) : (
              <div
                key={`t-${i}`}
                className={part._tag === "tool-result" && part.isFailure ? "tool-frame tool-failed" : "tool-frame tool-done"}
              >
                {part._tag === "tool-result" && part.isFailure ? "✗" : "✓"} {part.id}
              </div>
            )
          )}
          {streamingText}
          {pending ? <span className="streaming-cursor" aria-hidden /> : null}
        </div>
      ) : null}
      {streamError !== null ? <p className="error">{streamError}</p> : null}
      <form className="composer" onSubmit={handleSubmit}>
        <input
          type="text"
          placeholder="Type a message..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={pending}
        />
        <button type="submit" disabled={pending || input.trim().length === 0}>
          {pending ? "Sending..." : "Send"}
        </button>
      </form>
    </main>
  )
}
