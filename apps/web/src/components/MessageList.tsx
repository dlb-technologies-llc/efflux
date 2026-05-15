import type { Message } from "@effect-flue/shared"

export interface MessageListProps {
  readonly messages: ReadonlyArray<Message>
}

export function MessageList({ messages }: MessageListProps) {
  if (messages.length === 0) {
    return <p className="pending">No messages yet — say hello below.</p>
  }
  return (
    <ul className="messages">
      {messages.map((m, i) => (
        <li
          key={`${m.role}-${i}`}
          className={`message message-${m.role}`}
        >
          <div className="role">{m.role}</div>
          {m.content}
        </li>
      ))}
    </ul>
  )
}
