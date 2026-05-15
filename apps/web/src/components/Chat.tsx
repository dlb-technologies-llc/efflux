import { useAtom, useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { Cause, Exit } from "effect"
import { AsyncResult } from "effect/unstable/reactivity"
import * as React from "react"
import { historyAtom, historyKey, promptAtom, streamAtom } from "../atoms.ts"
import { MessageList } from "./MessageList.tsx"

export interface ChatProps {
  readonly name: string
  readonly id: string
}

export function Chat({ name, id }: ChatProps) {
  // Controlled input is the only local state. Loading / error / messages all
  // come from atom results.
  const [input, setInput] = React.useState("")
  const [submitError, setSubmitError] = React.useState<string | null>(null)

  // Memoise the family key so the per-session history atom is stable across
  // renders and `useAtom` subscribes to one underlying atom for the session.
  const sessionAtom = React.useMemo(() => historyAtom(historyKey({ name, id })), [name, id])

  const historyResult = useAtomValue(sessionAtom)
  const refreshHistory = useAtomRefresh(sessionAtom)

  const [streamResult, startStream] = useAtom(streamAtom)
  const promptSet = useAtomSet(promptAtom, { mode: "promiseExit" })

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const message = input.trim()
    if (message.length === 0) return
    setSubmitError(null)
    setInput("")

    // Kick off the SSE stream in parallel so deltas appear live alongside the
    // non-streaming POST that the server persists into history.
    startStream({ name, id, message })

    const exit = await promptSet({ name, id, message })
    Exit.match(exit, {
      onFailure: (cause) => {
        // v4: Cause is flat — iterate the reasons array for the first Fail.
        const failReason = cause.reasons.find(Cause.isFailReason)
        setSubmitError(failReason ? failReason.error.message : "Something went wrong")
      },
      onSuccess: () => {
        refreshHistory()
      },
    })
  }

  const pending = historyResult.waiting || streamResult.waiting

  const liveDelta = AsyncResult.match(streamResult, {
    onInitial: () => null,
    onFailure: () => null,
    onSuccess: (success) => (success.value._tag === "text-delta" ? success.value.delta : null),
  })

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
      {liveDelta !== null
        ? (
          <div className="message message-assistant pending">
            <div className="role">assistant (streaming)</div>
            {liveDelta}
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
