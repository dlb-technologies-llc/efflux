import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { Cause, Exit } from "effect"
import { AsyncResult } from "effect/unstable/reactivity"
import * as React from "react"
import { deleteSkillFn, putSkillFn, skillContentAtom, skillsListAtom } from "../atoms/skills.ts"
import styles from "./SkillsPanel.module.css"

/** Valid skill name: alphanumerics, underscore, hyphen; 1–64 chars (mirrors the server `SafeId`). */
const SKILL_NAME = /^[a-zA-Z0-9_-]{1,64}$/

/** Extract a string `message` from an unknown error (not every union member carries one). */
const messageOf = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = error.message
    if (typeof message === "string") return message
  }
  return String(error)
}

/** Pull the first fail-reason error out of a mutation's `Exit` cause, or a fallback message. */
const failureMessage = (cause: Cause.Cause<unknown>, fallback: string): string => {
  const failReason = cause.reasons.find(Cause.isFailReason)
  return failReason ? messageOf(failReason.error) : fallback
}

interface SkillEditorProps {
  readonly name: string
  readonly onDeleted: () => void
}

/**
 * Editor for a single selected skill: loads its markdown via `skillContentAtom(name)`
 * into a controlled `<textarea>`, saves through `putSkillFn`, and deletes through
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
    <section className={styles.editor}>
      <header className={styles.editorHead}>
        <h3 className={styles.editorName}>{name}</h3>
        <div className={styles.editorActions}>
          <button type="button" onClick={handleSave} disabled={pending || draft === null}>
            {pending ? "Working..." : "Save"}
          </button>
          <button type="button" className={styles.danger} onClick={handleDelete} disabled={pending}>
            Delete
          </button>
        </div>
      </header>
      {AsyncResult.match(contentResult, {
        onInitial: () => <p className={styles.pending}>Loading skill...</p>,
        onFailure: (failure) => (
          <p className={styles.error}>{failureMessage(failure.cause, "Failed to load skill")}</p>
        ),
        onSuccess: () => (
          <textarea
            className={styles.textarea}
            value={draft ?? ""}
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
          />
        ),
      })}
      {error !== null ? <p className={styles.error}>{error}</p> : null}
    </section>
  )
}

/**
 * Skills management panel: lists R2-backed skills, views/edits a selected skill's
 * markdown, adds new skills, and deletes them — all through the `/skills` CRUD
 * endpoints. Self-driven (no props); Wave 3 composes it into `App.tsx`.
 */
export function SkillsPanel() {
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
    if (!SKILL_NAME.test(name)) {
      setAddError("Name must match /^[a-zA-Z0-9_-]{1,64}$/")
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
    <main className={styles.panel}>
      <h1 className={styles.title}>Skills</h1>
      <div className={styles.layout}>
        <div className={styles.sidebar}>
          {AsyncResult.match(list, {
            onInitial: () => <p className={styles.pending}>Loading skills...</p>,
            onFailure: (failure) => (
              <p className={styles.error}>{failureMessage(failure.cause, "Failed to load skills")}</p>
            ),
            onSuccess: (success) =>
              success.value.skills.length === 0 ? (
                <p className={styles.empty}>No skills yet.</p>
              ) : (
                <ul className={styles.list}>
                  {success.value.skills.map((skill) => (
                    <li key={skill.name}>
                      <button
                        type="button"
                        className={skill.name === selected ? styles.itemSelected : styles.item}
                        onClick={() => setSelected(skill.name)}
                      >
                        <span className={styles.itemName}>{skill.name}</span>
                        <span className={styles.itemDesc}>{skill.description}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ),
          })}

          <form className={styles.addForm} onSubmit={handleAdd}>
            <h2 className={styles.addTitle}>Add skill</h2>
            <input
              type="text"
              placeholder="skill-name"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              disabled={adding}
            />
            <textarea
              className={styles.addTextarea}
              placeholder="# Markdown content"
              value={newContent}
              onChange={(event) => setNewContent(event.target.value)}
              disabled={adding}
            />
            <button type="submit" disabled={adding || newName.trim().length === 0}>
              {adding ? "Adding..." : "Add skill"}
            </button>
            {addError !== null ? <p className={styles.error}>{addError}</p> : null}
          </form>
        </div>

        <div className={styles.detail}>
          {selected !== null ? (
            <SkillEditor key={selected} name={selected} onDeleted={() => setSelected(null)} />
          ) : (
            <p className={styles.empty}>Select a skill to view or edit.</p>
          )}
        </div>
      </div>
    </main>
  )
}
