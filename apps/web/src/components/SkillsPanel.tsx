import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { SafeName } from "@effect-flue/shared"
import { Exit, Schema } from "effect"
import { AsyncResult } from "effect/unstable/reactivity"
import { BookOpen } from "lucide-react"
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
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { deleteSkillFn, putSkillFn, skillContentAtom, skillsListAtom } from "../atoms/skills.ts"
import { failureMessage } from "../errors.ts"
import { AsyncBoundary } from "./AsyncBoundary.tsx"

/** Valid skill name, derived from the shared `SafeName` schema (alphanumerics, underscore, hyphen; 1–64 chars). */
const isSkillName = Schema.is(SafeName)

interface SkillEditorProps {
  readonly name: string
  readonly onDeleted: () => void
}

/**
 * Editor for a single selected skill: loads its markdown via `skillContentAtom(name)`
 * into a controlled `Textarea`, saves through `putSkillFn`, and deletes through
 * `deleteSkillFn`. Keyed by `name` in the parent so switching skills remounts it and
 * reseeds the draft from the freshly loaded content.
 */
function SkillEditor({ name, onDeleted }: SkillEditorProps) {
  const contentResult = useAtomValue(skillContentAtom(name))
  const refreshContent = useAtomRefresh(skillContentAtom(name))
  const refreshList = useAtomRefresh(skillsListAtom)
  const runPut = useAtomSet(putSkillFn, { mode: "promiseExit" })
  const runDelete = useAtomSet(deleteSkillFn, { mode: "promiseExit" })

  const [draft, setDraft] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)

  React.useEffect(() => {
    if (AsyncResult.isSuccess(contentResult)) setDraft(contentResult.value.content)
  }, [contentResult])

  const handleSave = async () => {
    if (draft === null) return
    setPending(true)
    setError(null)
    const exit = await runPut({ name, content: draft })
    setPending(false)
    Exit.match(exit, {
      onFailure: (cause) => setError(failureMessage(cause, "Save failed")),
      onSuccess: () => {
        refreshList()
        refreshContent()
      },
    })
  }

  const handleDelete = async () => {
    setPending(true)
    setError(null)
    const exit = await runDelete(name)
    setPending(false)
    Exit.match(exit, {
      onFailure: (cause) => setError(failureMessage(cause, "Delete failed")),
      onSuccess: () => {
        refreshList()
        onDeleted()
      },
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-mono text-sm font-medium text-foreground">{name}</h3>
        <div className="flex gap-2">
          <Button type="button" size="sm" onClick={handleSave} disabled={pending || draft === null}>
            {pending ? "Working..." : "Save"}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={handleDelete}
            disabled={pending}
          >
            Delete
          </Button>
        </div>
      </div>
      <AsyncBoundary result={contentResult} onRetry={refreshContent}>
        {() => (
          <Textarea
            className="field-sizing-fixed min-h-0 flex-1 resize-none font-mono text-sm"
            value={draft ?? ""}
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
          />
        )}
      </AsyncBoundary>
      {error !== null ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  )
}

/**
 * Dialog body: a `ScrollArea` list of R2-backed skills plus an add form on the
 * left, and the selected skill's `SkillEditor` on the right. Lives inside
 * `DialogContent` so its atoms subscribe (and the skills list fetches) only once
 * the dialog opens, and its selection state resets on each open.
 */
function SkillsManager() {
  const list = useAtomValue(skillsListAtom)
  const refreshList = useAtomRefresh(skillsListAtom)
  const runPut = useAtomSet(putSkillFn, { mode: "promiseExit" })

  const [selected, setSelected] = React.useState<string | null>(null)
  const [newName, setNewName] = React.useState("")
  const [newContent, setNewContent] = React.useState("")
  const [addError, setAddError] = React.useState<string | null>(null)
  const [adding, setAdding] = React.useState(false)

  const handleAdd = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const name = newName.trim()
    if (!isSkillName(name)) {
      setAddError("Name must be alphanumerics, underscore, or hyphen; 1–64 chars")
      return
    }
    setAdding(true)
    setAddError(null)
    const exit = await runPut({ name, content: newContent })
    setAdding(false)
    Exit.match(exit, {
      onFailure: (cause) => setAddError(failureMessage(cause, "Add failed")),
      onSuccess: () => {
        refreshList()
        setSelected(name)
        setNewName("")
        setNewContent("")
      },
    })
  }

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 sm:grid-cols-[minmax(0,16rem)_1fr]">
      <aside className="flex min-h-0 min-w-0 flex-col gap-3">
        <ScrollArea className="min-h-0 flex-1 rounded-md border">
          <AsyncBoundary result={list} onRetry={refreshList}>
            {(value) =>
              value.skills.length === 0 ? (
                <p className="p-3 text-sm text-muted-foreground">No skills yet.</p>
              ) : (
                <ul className="flex flex-col gap-1 p-1">
                  {value.skills.map((skill) => (
                    <li key={skill.name}>
                      <button
                        type="button"
                        onClick={() => setSelected(skill.name)}
                        aria-current={skill.name === selected}
                        className={cn(
                          "flex w-full flex-col gap-0.5 rounded-md border border-transparent px-2.5 py-1.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground",
                          skill.name === selected && "border-border bg-accent text-accent-foreground",
                        )}
                      >
                        <span className="font-mono text-sm font-medium text-foreground">
                          {skill.name}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {skill.description}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
          </AsyncBoundary>
        </ScrollArea>

        <form className="flex shrink-0 flex-col gap-2" onSubmit={handleAdd}>
          <p className="font-mono text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Add skill
          </p>
          <Input
            type="text"
            placeholder="skill-name"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            disabled={adding}
          />
          <Textarea
            className="field-sizing-fixed min-h-20 resize-none font-mono text-sm"
            placeholder="# Markdown content"
            value={newContent}
            onChange={(event) => setNewContent(event.target.value)}
            disabled={adding}
          />
          <Button type="submit" size="sm" disabled={adding || newName.trim().length === 0}>
            {adding ? "Adding..." : "Add skill"}
          </Button>
          {addError !== null ? <p className="text-sm text-destructive">{addError}</p> : null}
        </form>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-col">
        {selected !== null ? (
          <SkillEditor key={selected} name={selected} onDeleted={() => setSelected(null)} />
        ) : (
          <p className="text-sm text-muted-foreground">Select a skill to view or edit.</p>
        )}
      </div>
    </div>
  )
}

/**
 * Self-contained skills manager: renders its own trigger `Button` and a
 * full-width `Dialog` holding the list + editor. Propless — `App` drops it into
 * the top bar and it drives everything off the `/skills` CRUD atoms itself.
 */
export function SkillsPanel() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm">
          <BookOpen />
          Skills
        </Button>
      </DialogTrigger>
      <DialogContent className="flex h-[80vh] flex-col gap-4 sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Skills</DialogTitle>
          <DialogDescription>
            Manage the R2-backed skills the agent can load per session.
          </DialogDescription>
        </DialogHeader>
        <SkillsManager />
      </DialogContent>
    </Dialog>
  )
}
