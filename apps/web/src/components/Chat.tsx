import { useAtom, useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { Cause } from "effect"
import { AsyncResult } from "effect/unstable/reactivity"
import * as React from "react"
import { historyAtom, historyKey, streamAtom } from "../atoms.ts"
import { MessageList } from "./MessageList.tsx"

export interface ChatProps {
  readonly name: string
  readonly id: string
}

export function Chat({ name, id }: ChatProps) {
  // Controlled input + accumulated stream text. `submitError` mirrors stream
  // failures into the UI; everything else is driven by atom results.
  const [input, setInput] = React.useState("")
  const [submitError, setSubmitError] = React.useState<string | null>(null)
  const [streamingText, setStreamingText] = React.useState<string>("")

  // Memoise the family key so the per-session history atom is stable across
  // renders and `useAtomValue` subscribes to one underlying atom per session.
  const sessionAtom = React.useMemo(() => historyAtom(historyKey({ name, id })), [name, id])

  const historyResult = useAtomValue(sessionAtom)
  const refreshHistory = useAtomRefresh(sessionAtom)

  // Stream is the single source of truth for the model call. The Worker's
  // streamPrompt persists the assistant message to DO storage on completion
  // (and partial text on interrupt), so refetching `historyAtom` after the
  // stream ends is what restores authoritative history.
  const [streamResult, startStream] = useAtom(streamAtom)

  // Watch streamResult and accumulate text deltas / clean up on completion.
  // Note: this is a stream transform (fold), not a mutation side-effect — the
  // anti-pattern the skill flags is using useEffect for mutation responses.
  React.useEffect(() => {
    AsyncResult.match(streamResult, {
      onInitial: () => undefined,
      onFailure: (failure) => {
        const failReason = failure.cause.reasons.find(Cause.isFailReason)
        setSubmitError(failReason ? failReason.error.message : "Stream failed")
        setStreamingText("")
      },
      onSuccess: (success) => {
        const part = success.value
        if (part._tag === "text-delta") {
          setStreamingText((prev) => prev + part.delta)
        } else if (part._tag === "done") {
          setStreamingText("")
          refreshHistory()
        }
      },
    })
  }, [streamResult, refreshHistory])

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const message = input.trim()
    if (message.length === 0) return
    setSubmitError(null)
    setInput("")
    setStreamingText("")
    startStream({ name, id, message })
  }

  const pending = historyResult.waiting || streamResult.waiting

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
              Failed to load history: {failReason ? failReason.error.message : "Something went wrong"}
            </p>
          )
        },
        onSuccess: (success) => <MessageList messages={success.value.history} />,
      })}
      {streamingText.length > 0
        ? (
          <div className="message message-assistant pending">
            <div className="role">assistant (streaming)</div>
            {streamingText}
          </div>
        )
        : null}
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
