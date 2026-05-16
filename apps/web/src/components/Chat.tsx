import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { Cause, Exit } from "effect"
import { AsyncResult } from "effect/unstable/reactivity"
import * as React from "react"
import { historyAtom, historyKey, promptAtom } from "../atoms.ts"
import { MessageList } from "./MessageList.tsx"

export interface ChatProps {
  readonly name: string
  readonly id: string
}

export function Chat({ name, id }: ChatProps) {
  const [input, setInput] = React.useState("")
  const [submitError, setSubmitError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)

  const sessionAtom = React.useMemo(
    () => historyAtom(historyKey({ name, id })),
    [name, id],
  )
  const historyResult = useAtomValue(sessionAtom)
  const refreshHistory = useAtomRefresh(sessionAtom)
  const sendPrompt = useAtomSet(promptAtom, { mode: "promiseExit" })

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const message = input.trim()
    if (message.length === 0) return
    setSubmitError(null)
    setInput("")
    setPending(true)
    const exit = await sendPrompt({ name, id, message })
    setPending(false)
    Exit.match(exit, {
      onFailure: (cause) => {
        const failReason = cause.reasons.find(Cause.isFailReason)
        setSubmitError(failReason ? failReason.error.message : "Stream failed")
      },
      onSuccess: () => {
        refreshHistory()
      },
    })
  }

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
      {pending ? (
        <div className="message message-assistant pending">
          <div className="role">assistant</div>
          thinking...
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
