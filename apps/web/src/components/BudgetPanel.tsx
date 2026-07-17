import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import type { SessionUsage } from "@efflux/shared"
import { Exit } from "effect"
import * as React from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { sessionUsageAtom, setBudgetFn } from "../atoms/budget.ts"
import { sessionConfigAtom } from "../atoms/tools.ts"
import { failureMessage } from "../errors.ts"
import { currentSessionAtom, type SessionArgs } from "../session.ts"
import { AsyncBoundary } from "./AsyncBoundary.tsx"
import { StatusPill } from "./StatusPill.tsx"

/** Group a token count with grouping separators; the value is machine data, so callers render it mono + `tabular-nums`. */
const fmtTokens = (n: number): string => n.toLocaleString("en-US")

/** Render a USD cost to 4dp — OpenRouter reports fractional cents. */
const fmtCost = (n: number): string => `$${n.toFixed(4)}`

/** Parse a trimmed cap input: empty string means "no cap" (null); anything else parses to a number for the caller to validate. */
const parseCap = (raw: string): number | null => {
  const trimmed = raw.trim()
  return trimmed.length === 0 ? null : Number(trimmed)
}

/** The spend + editor body, seeded from the loaded `usage`. Remounted (via `key`) whenever the stored caps change, so the inputs re-seed after a save. */
function BudgetEditor({
  session,
  usage,
  onSaved,
}: {
  readonly session: SessionArgs
  readonly usage: SessionUsage
  readonly onSaved: () => void
}) {
  const [tokenInput, setTokenInput] = React.useState(
    usage.maxTotalTokens === null ? "" : String(usage.maxTotalTokens),
  )
  const [costInput, setCostInput] = React.useState(usage.maxCostUsd === null ? "" : String(usage.maxCostUsd))
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const run = useAtomSet(setBudgetFn, { mode: "promiseExit" })

  const hasCap = usage.maxTotalTokens !== null || usage.maxCostUsd !== null
  const status: { readonly state: "neutral" | "danger" | "success"; readonly label: string } = !hasCap
    ? { state: "neutral", label: "No limit" }
    : usage.exceeded
      ? { state: "danger", label: "Over limit" }
      : { state: "success", label: "Within limit" }

  const save = async (maxTotalTokens: number | null, maxCostUsd: number | null) => {
    setBusy(true)
    setError(null)
    const exit = await run({ ...session, maxTotalTokens, maxCostUsd })
    setBusy(false)
    Exit.match(exit, {
      onFailure: (cause) => setError(failureMessage(cause, "Could not update budget")),
      onSuccess: () => onSaved(),
    })
  }

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const tokens = parseCap(tokenInput)
    const cost = parseCap(costInput)
    if (tokens !== null && (!Number.isFinite(tokens) || tokens < 1)) {
      setError("Token limit must be a whole number of at least 1.")
      return
    }
    if (cost !== null && (!Number.isFinite(cost) || cost <= 0)) {
      setError("Cost limit must be greater than 0.")
      return
    }
    save(tokens === null ? null : Math.floor(tokens), cost)
  }

  const handleClear = () => {
    setTokenInput("")
    setCostInput("")
    save(null, null)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-2 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[0.72rem] uppercase tracking-wider text-muted-foreground">Spent this session</span>
          <StatusPill state={status.state} label={status.label} />
        </div>
        <div className="font-mono text-sm tabular-nums text-foreground">
          {fmtTokens(usage.totalTokens)} tokens
          {usage.totalCost > 0 ? ` · ${fmtCost(usage.totalCost)}` : ""}
        </div>
        <div className="font-mono text-xs tabular-nums text-muted-foreground">
          Limit:{" "}
          {usage.maxTotalTokens === null ? "no token cap" : `${fmtTokens(usage.maxTotalTokens)} tokens`}
          {usage.maxCostUsd === null ? "" : ` · ${fmtCost(usage.maxCostUsd)} cap`}
        </div>
      </div>

      <form className="flex flex-col gap-2" onSubmit={handleSubmit}>
        <label
          className="text-[0.72rem] uppercase tracking-wider text-muted-foreground"
          htmlFor="budget-token-cap"
        >
          Token limit
        </label>
        <Input
          id="budget-token-cap"
          inputMode="numeric"
          placeholder="whole tokens — blank for unlimited"
          value={tokenInput}
          onChange={(event) => setTokenInput(event.target.value)}
          className="h-8 font-mono text-xs tabular-nums"
          disabled={busy}
        />
        <label className="text-[0.72rem] uppercase tracking-wider text-muted-foreground" htmlFor="budget-cost-cap">
          Cost limit (USD)
        </label>
        <Input
          id="budget-cost-cap"
          inputMode="decimal"
          placeholder="e.g. 5.00 — blank for unlimited"
          value={costInput}
          onChange={(event) => setCostInput(event.target.value)}
          className="h-8 font-mono text-xs tabular-nums"
          disabled={busy}
        />
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm" disabled={busy}>
            {busy ? "Saving..." : "Save limit"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleClear}
            disabled={busy || !hasCap}
          >
            Remove limit
          </Button>
        </div>
        {error !== null ? <p className="text-xs text-destructive">{error}</p> : null}
      </form>
    </div>
  )
}

/**
 * Budget panel: the current session's cumulative token/cost spend, whether it
 * has tripped its ceiling, and a form to set or clear the caps. Self-driven off
 * `sessionUsageAtom` for the current session; a save refetches both the usage
 * and the session config so the displayed limit and Tools gate badges stay in
 * sync. Enforcement lives in the Worker loop — an over-budget turn is refused
 * (a 402 on `prompt`/`/v1`, an in-band error frame on the chat stream).
 */
export function BudgetPanel() {
  const session = useAtomValue(currentSessionAtom)
  const usageResult = useAtomValue(sessionUsageAtom(session))
  const refreshUsage = useAtomRefresh(sessionUsageAtom(session))
  const refreshConfig = useAtomRefresh(sessionConfigAtom(session))

  const onSaved = () => {
    refreshUsage()
    refreshConfig()
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold">Budget</h2>
      <AsyncBoundary result={usageResult} onRetry={refreshUsage}>
        {(usage) => (
          <BudgetEditor
            key={`${usage.maxTotalTokens}:${usage.maxCostUsd}`}
            session={session}
            usage={usage}
            onSaved={onSaved}
          />
        )}
      </AsyncBoundary>
    </section>
  )
}
