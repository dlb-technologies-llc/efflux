import type { Message as ChatMessage } from "@effect-flue/shared"

import { Message } from "./Message.tsx"

/** Maps persisted history turns onto the shared {@link Message} render path; shows a muted prompt when the session is empty. */
export function MessageList({ messages }: { messages: ReadonlyArray<ChatMessage> }) {
  if (messages.length === 0) {
    return <p className="text-muted-foreground text-sm">No messages yet — say hello below.</p>
  }
  return (
    <div className="flex flex-col gap-4">
      {messages.map((message, index) => (
        <Message key={`${message.role}-${index}`} variant={message.role} content={message.content} />
      ))}
    </div>
  )
}
