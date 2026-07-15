import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import type { SecretSummary } from "@efflux/shared"
import { Exit } from "effect"
import { KeyRound } from "lucide-react"
import * as React from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { deleteSecretFn, putSecretFn, secretsAtom } from "../atoms/secrets.ts"
import { failureMessage } from "../errors.ts"
import { currentSessionAtom, type SessionArgs } from "../session.ts"
import { AsyncBoundary } from "./AsyncBoundary.tsx"

interface SecretRowProps {
  readonly session: SessionArgs
  readonly secret: SecretSummary
  readonly onChanged: () => void
}

/** One secret row: name + creation date, a two-step Delete button (a stored secret value is write-only and unrecoverable, so a stray click must not destroy it — the first click arms a Confirm/Cancel pair), and an inline rotate form (a password input + Rotate button that overwrites the value via the existing `putSecretFn` upsert). Both mutations refresh the parent list on success (`onChanged`), mirroring `ScheduledJobRow` in `ScheduledFeaturesPanel.tsx`. */
function SecretRow({ session, secret, onChanged }: SecretRowProps) {
  const runDelete = useAtomSet(deleteSecretFn, { mode: "promiseExit" })
  const runRotate = useAtomSet(putSecretFn, { mode: "promiseExit" })
  const [newValue, setNewValue] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [confirming, setConfirming] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const handleDelete = async () => {
    setBusy(true)
    setError(null)
    const exit = await runDelete({ ...session, key: secret.name })
    setBusy(false)
    Exit.match(exit, {
      onFailure: (cause) => setError(failureMessage(cause, "Delete failed")),
      onSuccess: () => onChanged(),
    })
  }

  const handleRotate = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (newValue.length === 0) return
    setBusy(true)
    setError(null)
    const exit = await runRotate({ ...session, key: secret.name, value: newValue })
    setBusy(false)
    Exit.match(exit, {
      onFailure: (cause) => setError(failureMessage(cause, "Rotate failed")),
      onSuccess: () => {
        setNewValue("")
        onChanged()
      },
    })
  }

  return (
    <li className="flex flex-col gap-2 rounded-md border border-border px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-sm font-medium text-foreground">{secret.name}</span>
        {confirming ? (
          <div className="flex items-center gap-1">
            <Button type="button" variant="destructive" size="sm" onClick={handleDelete} disabled={busy}>
              {busy ? "Working..." : "Confirm delete"}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button type="button" variant="destructive" size="sm" onClick={() => setConfirming(true)} disabled={busy}>
            Delete
          </Button>
        )}
      </div>
      <span className="font-mono text-xs text-muted-foreground">
        Added {new Date(secret.createdAt).toLocaleDateString()}
      </span>
      <form className="flex items-center gap-2" onSubmit={handleRotate}>
        <Input
          type="password"
          autoComplete="off"
          placeholder="New value to rotate"
          value={newValue}
          onChange={(event) => setNewValue(event.target.value)}
          className="h-8 flex-1 font-mono text-xs"
        />
        <Button type="submit" variant="secondary" size="sm" disabled={busy || newValue.length === 0}>
          Rotate
        </Button>
      </form>
      {error !== null ? <p className="text-sm text-destructive">{error}</p> : null}
    </li>
  )
}

/** Dialog body: a `ScrollArea` list of the current session's stored secrets. Lives inside `DialogContent` so `secretsAtom` subscribes (and fetches) only when the dialog opens; refetches via `useAtomRefresh` after a row's delete/rotate succeeds. Mirrors `ScheduledFeaturesManager`. */
function SecretsManager() {
  const session = useAtomValue(currentSessionAtom)
  const list = useAtomValue(secretsAtom(session))
  const refreshList = useAtomRefresh(secretsAtom(session))

  return (
    <ScrollArea className="min-h-0 flex-1 rounded-md border">
      <AsyncBoundary result={list} onRetry={refreshList}>
        {(value) =>
          value.secrets.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">No secrets stored yet.</p>
          ) : (
            <ul className="flex flex-col gap-2 p-3">
              {value.secrets.map((secret) => (
                <SecretRow key={secret.name} session={session} secret={secret} onChanged={refreshList} />
              ))}
            </ul>
          )}
      </AsyncBoundary>
    </ScrollArea>
  )
}

/** Self-contained secrets manager: renders its own trigger `Button` and a `Dialog` holding the list. Propless — `App` drops it into the top bar alongside `SkillsPanel`/`ScheduledFeaturesPanel`, and it drives everything off the `/secrets` atoms for the current session. */
export function SecretsPanel() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm">
          <KeyRound />
          Secrets
        </Button>
      </DialogTrigger>
      <DialogContent className="flex h-[80vh] flex-col gap-4 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Secrets</DialogTitle>
          <DialogDescription>
            Stored secrets for the current session. Values are never shown — only names.
          </DialogDescription>
        </DialogHeader>
        <SecretsManager />
      </DialogContent>
    </Dialog>
  )
}
