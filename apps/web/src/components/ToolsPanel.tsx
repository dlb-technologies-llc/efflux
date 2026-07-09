import { useAtomValue } from "@effect/atom-react"
import { type RulesMap, resolveRule, type ToolRule } from "@effect-flue/shared"
import { AsyncResult } from "effect/unstable/reactivity"
import * as React from "react"
import { sessionConfigAtom, toolsAtom } from "../atoms/tools.ts"
import { failureMessage } from "../errors.ts"
import { currentSessionAtom } from "../session.ts"
import styles from "./ToolsPanel.module.css"

/** Display label + style class per gate decision; keyed by the schema literal so it stays exhaustive with `ToolRule`. */
const gate: Record<typeof ToolRule.Type, { readonly label: string; readonly className: string }> = {
  allow: { label: "allow", className: styles.gateAllow ?? "" },
  ask: { label: "parks", className: styles.gateAsk ?? "" },
  deny: { label: "blocked", className: styles.gateDeny ?? "" },
}

/** The per-tool gate badge, resolved from the session's rules table. */
function GateBadge({ name, rules }: { readonly name: string; readonly rules: RulesMap }) {
  const rule = resolveRule(rules, name)
  return <span className={`${styles.badge} ${gate[rule].className}`}>{gate[rule].label}</span>
}

/**
 * Tools panel: lists the agent toolkit with each tool's description and its
 * per-tool approval gate for the current session, and expands to show the
 * tool's parameters JSON Schema. Self-driven — reads `toolsAtom` and the
 * current session's `sessionConfigAtom`; edits nothing.
 */
export function ToolsPanel() {
  const toolsResult = useAtomValue(toolsAtom)
  const session = useAtomValue(currentSessionAtom)
  const configResult = useAtomValue(sessionConfigAtom(session))
  const [openTool, setOpenTool] = React.useState<string | null>(null)

  const rules = AsyncResult.isSuccess(configResult) ? configResult.value.rules : undefined

  return (
    <section className={styles.panel}>
      <h2 className={styles.heading}>Tools</h2>
      {AsyncResult.match(toolsResult, {
        onInitial: () => <p className={styles.pending}>Loading tools...</p>,
        onFailure: (failure) => (
          <p className={styles.error}>
            Failed to load tools: {failureMessage(failure.cause, "Something went wrong")}
          </p>
        ),
        onSuccess: (success) => (
          <ul className={styles.list}>
            {success.value.tools.map((tool) => {
              const open = openTool === tool.name
              return (
                <li key={tool.name} className={styles.tool}>
                  <button
                    type="button"
                    className={styles.toolHeader}
                    aria-expanded={open}
                    onClick={() => setOpenTool(open ? null : tool.name)}
                  >
                    <span className={styles.caret} aria-hidden>{open ? "▾" : "▸"}</span>
                    <span className={styles.toolName}>{tool.name}</span>
                    {rules !== undefined ? <GateBadge name={tool.name} rules={rules} /> : null}
                  </button>
                  <p className={styles.toolDesc}>{tool.description}</p>
                  {open ? (
                    <div className={styles.schema}>
                      <pre>{JSON.stringify(tool.parameters, null, 2)}</pre>
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        ),
      })}
    </section>
  )
}
