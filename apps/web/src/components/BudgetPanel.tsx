import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { MaxCostUsd, MaxTotalTokens, type SessionUsage } from "@efflux/shared"
import { Exit, Result, Schema } from "effect"
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

const decodeTokenCap = Schema.decodeUnknownResult(MaxTotalTokens)
const decodeCostCap = Schema.decodeUnknownResult(MaxCostUsd)

/** Validate a cap field's raw text against its shared schema: blank is valid (means unlimited); otherwise the parsed number must decode through the same rule the server enforces. Returns an actionable message, or null when valid. */
const capError = (
  raw: string,
  decode: (value: unknown) => Result.Result<number, unknown>,
  message: string,
): string | null => {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  return Result.isSuccess(decode(Number(trimmed))) ? null : message
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

  const tokenError = capError(tokenInput, decodeTokenCap, "Whole number, at least 1 — or blank for unlimited.")
  const costError = capError(costInput, decodeCostCap, "Amount greater than 0 — or blank for unlimited.")
  const formValid = tokenError === null && costError === null

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
    if (!formValid) return
    const token = tokenInput.trim()
    const cost = costInput.trim()
    save(token.length === 0 ? null : Number(token), cost.length === 0 ? null : Number(cost))
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
          aria-invalid={tokenError !== null}
          className="h-8 font-mono text-xs tabular-nums"
          disabled={busy}
        />
        {tokenError !== null ? <p className="text-xs text-destructive">{tokenError}</p> : null}
        <label className="text-[0.72rem] uppercase tracking-wider text-muted-foreground" htmlFor="budget-cost-cap">
          Cost limit (USD)
        </label>
        <Input
          id="budget-cost-cap"
          inputMode="decimal"
          placeholder="e.g. 5.00 — blank for unlimited"
          value={costInput}
          onChange={(event) => setCostInput(event.target.value)}
          aria-invalid={costError !== null}
          className="h-8 font-mono text-xs tabular-nums"
          disabled={busy}
        />
        {costError !== null ? <p className="text-xs text-destructive">{costError}</p> : null}
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm" disabled={busy || !formValid}>
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
 * has tripped its ceiling, and a form to set or clear the caps. Field validation
 * decodes through the shared `MaxTotalTokens`/`MaxCostUsd` schemas — the same
 * rules the server enforces — so an impossible value can never be submitted.
 * Self-driven off `sessionUsageAtom`; a save (via the `PUT /config/budget` atom)
 * refetches both the usage and the session config so the displayed limit and the
 * Tools gate badges stay in sync. Enforcement lives in the Worker loop — an
 * over-budget turn is refused (a 402 on `prompt`/`/v1`, an in-band error frame on
 * the chat stream).
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
