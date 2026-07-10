import { ChevronRightIcon } from "lucide-react"
import * as React from "react"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import { StatusPill } from "./StatusPill.tsx"

/** Schema-agnostic view of a single tool invocation; callers map their own shapes to this. */
export interface ToolCallView {
  name: string
  params?: unknown
  result?: unknown
  isFailure?: boolean
  running?: boolean
}

/** A collapsible mono card summarizing a tool call, expanding to its output well. */
export function ToolCallCard({ call }: { call: ToolCallView }) {
  const [open, setOpen] = React.useState(false)
  const preview = call.params !== undefined ? JSON.stringify(call.params) : ""
  const payload = call.result ?? call.params
  const body = payload !== undefined ? JSON.stringify(payload, null, 2) : ""
  const pill = call.running ? (
    <StatusPill state="accent" label="running" dot />
  ) : call.isFailure ? (
    <StatusPill state="danger" label="failed" />
  ) : (
    <StatusPill state="success" label="exit 0" />
  )
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="border border-border rounded-lg bg-surface-2 overflow-hidden"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 font-mono text-xs text-left">
        <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open ? "rotate-90" : "",
          )}
        />
        <span className="text-primary shrink-0">{call.name}</span>
        <span className="text-muted-foreground truncate flex-1 min-w-0">
          {preview}
        </span>
        {pill}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="bg-bg-subtle font-mono text-xs overflow-x-auto p-3">
          {body}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  )
}
