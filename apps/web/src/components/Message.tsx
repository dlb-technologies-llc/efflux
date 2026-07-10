import { Markdown } from "./Markdown.tsx"
import { ToolCallCard, type ToolCallView } from "./ToolCallCard.tsx"

/** One render path for both persisted history turns and the live streaming turn. */
export function Message({
  role,
  content,
  streaming,
  tools,
}: {
  role: "user" | "assistant"
  content: string
  streaming?: boolean
  tools?: ReadonlyArray<ToolCallView>
}) {
  if (role === "user") {
    return (
      <div className="self-end max-w-[85%] bg-accent-ghost border border-accent-line rounded-xl rounded-br-sm px-3.5 py-2.5 text-foreground whitespace-pre-wrap">
        {content}
      </div>
    )
  }
  return (
    <div className="w-full flex flex-col gap-2">
      {tools?.map((tool, index) => (
        <ToolCallCard key={`${tool.name}-${index}`} call={tool} />
      ))}
      {streaming ? (
        <div aria-live="polite">
          <Markdown content={content} />
          <span className="inline-block w-1.5 h-4 align-text-bottom bg-primary animate-pulse ml-0.5" />
        </div>
      ) : (
        <Markdown content={content} />
      )}
    </div>
  )
}
