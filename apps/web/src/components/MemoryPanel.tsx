import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import type { MemoryEntry, MemorySummary } from "@efflux/shared"
import {
  MEMORY_MAX_CONTENT_LENGTH,
  MEMORY_MAX_DESCRIPTION_LENGTH,
  PutMemoryRequest,
  SafeName,
} from "@efflux/shared"
import { Exit, Result, Schema } from "effect"
import { Brain, ChevronDown } from "lucide-react"
import * as React from "react"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
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
import { Textarea } from "@/components/ui/textarea"
import { deleteMemoryFn, memoriesAtom, memoryEntryAtom, putMemoryFn } from "../atoms/memory.ts"
import { failureMessage } from "../errors.ts"
import { currentSessionAtom } from "../session.ts"
import { AsyncBoundary } from "./AsyncBoundary.tsx"

const decodeName = Schema.decodeUnknownResult(SafeName)
const decodePut = Schema.decodeUnknownResult(PutMemoryRequest)

/** Validate a memory name against the shared `SafeName` schema — the same rule the server enforces. Returns an actionable message, or null when valid (blank is handled by the disabled submit, not an error). */
const nameError = (raw: string): string | null => {
  if (raw.length === 0) return null
  return Result.isSuccess(decodeName(raw))
    ? null
    : "Use a short name: letters, digits, hyphens, underscores."
}

/** Validate description + content by decoding through the shared `PutMemoryRequest` schema — the same length caps the server enforces (never a hand-rolled bound). Returns an actionable message, or null when valid; blanks are handled by the disabled submit. */
const putError = (description: string, content: string): string | null => {
  if (description.length === 0 || content.length === 0) return null
  return Result.isSuccess(decodePut({ description, content }))
    ? null
    : `Keep the description within ${MEMORY_MAX_DESCRIPTION_LENGTH} characters and content within ${MEMORY_MAX_CONTENT_LENGTH.toLocaleString("en-US")} characters.`
}

/** Inline editor for one loaded memory fact, seeded from the entry (parent remounts it via `key` on `updatedAt` so a save re-seeds). Saves through the same upsert the add form uses. */
function MemoryEditor({
  agent,
  entry,
  onSaved,
}: {
  readonly agent: string
  readonly entry: MemoryEntry
  readonly onSaved: () => void
}) {
  const runPut = useAtomSet(putMemoryFn, { mode: "promiseExit" })
  const [description, setDescription] = React.useState(entry.description)
  const [content, setContent] = React.useState(entry.content)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const capsInvalid = putError(description, content)

  const handleSave = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (description.length === 0 || content.length === 0 || capsInvalid !== null) return
    setBusy(true)
    setError(null)
    const exit = await runPut({ agent, name: entry.name, description, content })
    setBusy(false)
    Exit.match(exit, {
      onFailure: (cause) => setError(failureMessage(cause, "Save failed")),
      onSuccess: () => onSaved(),
    })
  }

  return (
    <form className="flex flex-col gap-2" onSubmit={handleSave}>
      <Input
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        placeholder="One-line description (shown in the index)"
        className="h-8 text-xs"
      />
      <Textarea
        value={content}
        onChange={(event) => setContent(event.target.value)}
        placeholder="Full fact content"
        className="min-h-24 font-mono text-xs"
      />
      <div className="flex items-center justify-end gap-2">
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          disabled={busy || description.length === 0 || content.length === 0 || capsInvalid !== null}
        >
          {busy ? "Saving..." : "Save"}
        </Button>
      </div>
      {capsInvalid !== null ? <p className="text-sm text-destructive">{capsInvalid}</p> : null}
      {error !== null ? <p className="text-sm text-destructive">{error}</p> : null}
    </form>
  )
}

/** The expanded body of one memory row — mounted ONLY while the row is open, so the full fact is fetched lazily on expand (subscribing in the collapsed row would fire one GET per listed memory the moment the dialog opens, up to the 200-entry cap). */
function MemoryRowBody({
  agent,
  name,
  onChanged,
}: {
  readonly agent: string
  readonly name: string
  readonly onChanged: () => void
}) {
  const entryKey = `${agent}/${name}`
  const entry = useAtomValue(memoryEntryAtom(entryKey))
  const refreshEntry = useAtomRefresh(memoryEntryAtom(entryKey))

  return (
    <AsyncBoundary result={entry} onRetry={refreshEntry}>
      {(value) => (
        <MemoryEditor
          key={value.updatedAt}
          agent={agent}
          entry={value}
          onSaved={() => {
            refreshEntry()
            onChanged()
          }}
        />
      )}
    </AsyncBoundary>
  )
}

/** One memory row: a Collapsible whose header shows name + description + updated date and a two-step Delete (a memory is distilled from a conversation that may be gone — not trivially re-creatable, so the first click arms a Confirm/Cancel pair, mirroring `SecretRow`). Expanding mounts `MemoryRowBody`, which lazily loads the full fact and offers an inline editor. */
function MemoryRow({
  agent,
  memory,
  onChanged,
}: {
  readonly agent: string
  readonly memory: MemorySummary
  readonly onChanged: () => void
}) {
  const runDelete = useAtomSet(deleteMemoryFn, { mode: "promiseExit" })
  const [open, setOpen] = React.useState(false)
  const [confirming, setConfirming] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const handleDelete = async () => {
    setBusy(true)
    setError(null)
    const exit = await runDelete({ agent, name: memory.name })
    setBusy(false)
    Exit.match(exit, {
      onFailure: (cause) => setError(failureMessage(cause, "Delete failed")),
      onSuccess: () => onChanged(),
    })
  }

  return (
    <li className="flex flex-col gap-2 rounded-md border border-border px-3 py-2">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex items-center justify-between gap-2">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
            >
              <ChevronDown
                className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`}
              />
              <span className="truncate font-mono text-sm font-medium text-foreground">
                {memory.name}
              </span>
            </button>
          </CollapsibleTrigger>
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
        <p className="pl-6 text-sm text-muted-foreground">{memory.description}</p>
        <span className="pl-6 font-mono text-xs text-muted-foreground">
          Updated {new Date(memory.updatedAt).toLocaleDateString()}
        </span>
        <CollapsibleContent>
          <div className="mt-2 flex flex-col gap-2 pl-6">
            {open ? <MemoryRowBody agent={agent} name={memory.name} onChanged={onChanged} /> : null}
          </div>
        </CollapsibleContent>
      </Collapsible>
      {error !== null ? <p className="text-sm text-destructive">{error}</p> : null}
    </li>
  )
}

/** Add-a-memory form: name validated by decoding through the shared `SafeName` schema (never a hand-rolled regex), description + content required. Uses the same `putMemoryFn` upsert as the row editor. */
function MemoryAddForm({ agent, onChanged }: { readonly agent: string; readonly onChanged: () => void }) {
  const runPut = useAtomSet(putMemoryFn, { mode: "promiseExit" })
  const [name, setName] = React.useState("")
  const [description, setDescription] = React.useState("")
  const [content, setContent] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const nameInvalid = nameError(name)
  const capsInvalid = putError(description, content)
  const formValid =
    name.length > 0 &&
    nameInvalid === null &&
    capsInvalid === null &&
    description.length > 0 &&
    content.length > 0

  const handleAdd = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!formValid) return
    setBusy(true)
    setError(null)
    const exit = await runPut({ agent, name, description, content })
    setBusy(false)
    Exit.match(exit, {
      onFailure: (cause) => setError(failureMessage(cause, "Add failed")),
      onSuccess: () => {
        setName("")
        setDescription("")
        setContent("")
        onChanged()
      },
    })
  }

  return (
    <form className="flex flex-col gap-2 rounded-md border border-border p-3" onSubmit={handleAdd}>
      <div className="flex items-center gap-2">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="name (kebab-case)"
          className="h-8 flex-1 font-mono text-xs"
        />
        <Input
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="One-line description"
          className="h-8 flex-[2] text-xs"
        />
      </div>
      {nameInvalid !== null ? <p className="text-sm text-destructive">{nameInvalid}</p> : null}
      {capsInvalid !== null ? <p className="text-sm text-destructive">{capsInvalid}</p> : null}
      <Textarea
        value={content}
        onChange={(event) => setContent(event.target.value)}
        placeholder="Full fact content"
        className="min-h-16 font-mono text-xs"
      />
      <div className="flex items-center justify-end">
        <Button type="submit" variant="secondary" size="sm" disabled={busy || !formValid}>
          {busy ? "Adding..." : "Add memory"}
        </Button>
      </div>
      {error !== null ? <p className="text-sm text-destructive">{error}</p> : null}
    </form>
  )
}

/** Dialog body: the add form plus a `ScrollArea` list of the agent's memories. Lives inside `DialogContent` so `memoriesAtom` subscribes (and fetches) only when the dialog opens; refetches after any row/form mutation succeeds. Mirrors `SecretsManager`. */
function MemoryManager({ agent }: { readonly agent: string }) {
  const list = useAtomValue(memoriesAtom(agent))
  const refreshList = useAtomRefresh(memoriesAtom(agent))

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <MemoryAddForm agent={agent} onChanged={refreshList} />
      <ScrollArea className="min-h-0 flex-1 rounded-md border">
        <AsyncBoundary result={list} onRetry={refreshList}>
          {(value) =>
            value.memories.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">No memories saved yet.</p>
            ) : (
              <ul className="flex flex-col gap-2 p-3">
                {value.memories.map((memory) => (
                  <MemoryRow key={memory.name} agent={agent} memory={memory} onChanged={refreshList} />
                ))}
              </ul>
            )}
        </AsyncBoundary>
      </ScrollArea>
    </div>
  )
}

/** Self-contained cross-session memory manager: a trigger `Button` + `Dialog` listing the current agent NAME's saved facts (shared by every session of that name — not per-session). Propless — `App` drops it into the top bar beside `SecretsPanel`. */
export function MemoryPanel() {
  const agent = useAtomValue(currentSessionAtom).name

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm">
          <Brain />
          Memory
        </Button>
      </DialogTrigger>
      <DialogContent className="flex h-[80vh] flex-col gap-4 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Memory — {agent}</DialogTitle>
          <DialogDescription>
            Facts the agent saves across sessions. Shared by every {agent} session; the index is
            injected into each turn.
          </DialogDescription>
        </DialogHeader>
        <MemoryManager agent={agent} />
      </DialogContent>
    </Dialog>
  )
}
