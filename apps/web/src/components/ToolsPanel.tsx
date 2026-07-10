import { useAtomValue } from "@effect/atom-react"
import { type RulesMap, resolveRule, type ToolInfo, type ToolRule } from "@efflux/shared"
import { AsyncResult } from "effect/unstable/reactivity"
import { ChevronRightIcon } from "lucide-react"
import * as React from "react"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import { sessionConfigAtom, toolsAtom } from "../atoms/tools.ts"
import { prettyParams } from "../format.ts"
import { currentSessionAtom } from "../session.ts"
import { AsyncBoundary } from "./AsyncBoundary.tsx"
import { StatusPill } from "./StatusPill.tsx"

/** Gate badge state + label per decision; keyed by the schema literal so it stays exhaustive with `ToolRule`. */
const gate: Record<
  typeof ToolRule.Type,
  { readonly state: "success" | "warning" | "danger"; readonly label: string }
> = {
  allow: { state: "success", label: "Allow" },
  ask: { state: "warning", label: "Ask" },
  deny: { state: "danger", label: "Deny" },
}

/** The per-tool gate badge, resolved from the session's rules table. */
function GateBadge({ name, rules }: { readonly name: string; readonly rules: RulesMap }) {
  const { state, label } = gate[resolveRule(rules, name)]
  return <StatusPill state={state} label={label} />
}

/** One toolkit entry: a collapsible whose header carries the tool name and gate badge, expanding to the description and parameters schema well. */
function ToolRow({ tool, rules }: { readonly tool: ToolInfo; readonly rules: RulesMap | undefined }) {
  const [open, setOpen] = React.useState(false)
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="border border-border rounded-lg bg-surface-2 overflow-hidden"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md">
        <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open ? "rotate-90" : "",
          )}
        />
        <span className="text-primary font-mono text-sm flex-1 min-w-0 truncate">{tool.name}</span>
        {rules !== undefined ? <GateBadge name={tool.name} rules={rules} /> : null}
      </CollapsibleTrigger>
      <CollapsibleContent className="px-3 pb-3">
        <p className="text-xs text-muted-foreground leading-relaxed mb-2">{tool.description}</p>
        <pre className="font-mono text-xs bg-bg-subtle border border-border rounded overflow-x-auto p-3">
          {prettyParams(tool.parameters)}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * Tools panel: lists the agent toolkit with each tool's per-tool approval gate
 * for the current session, expanding to the tool's description and parameters
 * JSON Schema. Self-driven — reads `toolsAtom` and the current session's
 * `sessionConfigAtom`; edits nothing.
 */
export function ToolsPanel() {
  const toolsResult = useAtomValue(toolsAtom)
  const session = useAtomValue(currentSessionAtom)
  const configResult = useAtomValue(sessionConfigAtom(session))

  const rules = AsyncResult.isSuccess(configResult) ? configResult.value.rules : undefined

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold">Tools</h2>
      <AsyncBoundary result={toolsResult}>
        {(response) => (
          <div className="flex flex-col gap-2">
            {response.tools.map((tool) => (
              <ToolRow key={tool.name} tool={tool} rules={rules} />
            ))}
          </div>
        )}
      </AsyncBoundary>
    </section>
  )
}
