import { Markdown } from "./Markdown.tsx"
import { ToolCallCard, type ToolCallView } from "./ToolCallCard.tsx"

/** One render path for both persisted history turns and the live streaming turn. */
export function Message({
  variant,
  content,
  skill,
  streaming,
  tools,
}: {
  variant: "user" | "assistant"
  content: string
  skill?: string
  streaming?: boolean
  tools?: ReadonlyArray<ToolCallView>
}) {
  if (variant === "user") {
    return (
      <div className="self-end flex flex-col items-end gap-1 max-w-[85%]">
        {skill !== undefined ? (
          <span
            className="font-mono text-[0.7rem] leading-none px-1.5 py-1 rounded border border-accent-line bg-accent-ghost text-accent-bright"
            title={`Invoked with the ${skill} skill`}
          >
            /{skill}
          </span>
        ) : null}
        <div className="bg-accent-ghost border border-accent-line rounded-xl rounded-br-sm px-3.5 py-2.5 text-foreground whitespace-pre-wrap">
          {content}
        </div>
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
          {content === "" && (tools === undefined || tools.length === 0) ? (
            <span className="text-muted-foreground text-sm">thinking…</span>
          ) : (
            <Markdown content={content} />
          )}
          <span className="inline-block w-1.5 h-4 align-text-bottom bg-primary animate-pulse motion-reduce:animate-none ml-0.5" />
        </div>
      ) : (
        <Markdown content={content} />
      )}
    </div>
  )
}
