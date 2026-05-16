import { useAtomRefresh, useAtomSet, useAtomSubscribe, useAtomValue } from "@effect/atom-react"
import type { StreamPart } from "@effect-flue/shared"
import { Cause, Exit } from "effect"
import { AsyncResult } from "effect/unstable/reactivity"
import * as React from "react"
import { historyAtom, historyKey, streamAtom } from "../atoms.ts"
import { MessageList } from "./MessageList.tsx"

export interface ChatProps {
  readonly name: string
  readonly id: string
}

export function Chat({ name, id }: ChatProps) {
  const [input, setInput] = React.useState("")
  const [submitError, setSubmitError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)
  const [streaming, setStreaming] = React.useState("")

  const sessionAtom = React.useMemo(
    () => historyAtom(historyKey({ name, id })),
    [name, id],
  )
  const historyResult = useAtomValue(sessionAtom)
  const refreshHistory = useAtomRefresh(sessionAtom)
  const runStream = useAtomSet(streamAtom, { mode: "promiseExit" })

  // Hold the per-emit handler in a ref so `useAtomSubscribe` sees a stable
  // callback identity. Without this, every setStreaming/setSubmitError call
  // re-renders, which would cause useAtomSubscribe to unsubscribe and
  // resubscribe between commits — async deltas arriving in that window
  // would have no subscriber attached.
  const onPartRef = React.useRef<(part: StreamPart) => void>(() => {})
  onPartRef.current = (part) => {
    if (part._tag === "text-delta") {
      setStreaming((prev) => prev + part.delta)
      return
    }
    if (part._tag === "error") {
      setSubmitError(part.message)
    }
  }
  const onResult = React.useCallback(
    (result: AsyncResult.AsyncResult<StreamPart, unknown>) => {
      if (!AsyncResult.isSuccess(result)) return
      onPartRef.current(result.value)
    },
    [],
  )
  useAtomSubscribe(streamAtom, onResult)

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const message = input.trim()
    if (message.length === 0) return
    setStreaming("")
    setSubmitError(null)
    setInput("")
    setPending(true)
    const exit = await runStream({ name, id, message })
    setPending(false)
    Exit.match(exit, {
      onFailure: (cause) => {
        const failReason = cause.reasons.find(Cause.isFailReason)
        setSubmitError(failReason ? failReason.error.message : "Stream failed")
      },
      // Don't clear `streaming` here — the bubble would disappear for the
      // duration of the history refetch and visually pop back. The success
      // effect below clears `streaming` once the refreshed history actually
      // contains the new assistant turn.
      onSuccess: () => {
        refreshHistory()
      },
    })
  }

  // Clear the live-streaming buffer only AFTER the refreshed history contains
  // the new assistant turn. Avoids the disappear-then-reappear flicker that
  // would otherwise happen between `setStreaming("")` and the historyAtom
  // refetch resolving.
  const previousHistoryLengthRef = React.useRef(0)
  React.useEffect(() => {
    if (!AsyncResult.isSuccess(historyResult)) return
    const length = historyResult.value.history.length
    if (length > previousHistoryLengthRef.current && streaming.length > 0) {
      setStreaming("")
    }
    previousHistoryLengthRef.current = length
  }, [historyResult, streaming.length])

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
      {streaming.length > 0 ? (
        <div className="message message-assistant message-streaming">
          <div className="role">assistant</div>
          {streaming}
          {pending ? <span className="streaming-cursor" aria-hidden /> : null}
        </div>
      ) : pending ? (
        <div className="message message-assistant pending">
          <div className="role">assistant</div>
          <span className="thinking-dots">thinking</span>
        </div>
      ) : null}
      {submitError !== null ? <p className="error">{submitError}</p> : null}
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
