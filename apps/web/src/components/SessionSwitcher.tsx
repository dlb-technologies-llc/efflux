import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { SafeId, type SessionInfo } from "@effect-flue/shared"
import { Schema } from "effect"
import { AsyncResult } from "effect/unstable/reactivity"
import * as React from "react"
import { sessionsAtom } from "../atoms/sessions.ts"
import { failureMessage } from "../errors.ts"
import { formatRelativeTime } from "../format.ts"
import { currentSessionAtom, selectedModelAtom } from "../session.ts"
import styles from "./SessionSwitcher.module.css"

/** Session `name`/`id` segment validator, derived from the shared `SafeId` schema the Worker's DO key uses. */
const isSegment = Schema.is(SafeId)

/**
 * Left-rail control: lists known sessions, lets the user switch to or create
 * the active session (`currentSessionAtom`), and picks the per-request model
 * override (`selectedModelAtom`). Every other panel reads those atoms — this is
 * the only writer.
 */
export function SessionSwitcher() {
  const sessions = useAtomValue(sessionsAtom)
  const refresh = useAtomRefresh(sessionsAtom)
  const current = useAtomValue(currentSessionAtom)
  const setSession = useAtomSet(currentSessionAtom)
  const model = useAtomValue(selectedModelAtom)
  const setModel = useAtomSet(selectedModelAtom)

  const [newName, setNewName] = React.useState("")
  const [newId, setNewId] = React.useState("")

  const nameValid = isSegment(newName)
  const idValid = isSegment(newId)

  const isActive = (session: SessionInfo): boolean =>
    session.name === current.name && session.id === current.id

  const handleCreate = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!nameValid || !idValid) return
    setSession({ name: newName, id: newId })
    setNewName("")
    setNewId("")
  }

  return (
    <aside className={styles.rail}>
      <div className={styles.header}>
        <h2 className={styles.title}>Sessions</h2>
        <button type="button" className={styles.refresh} onClick={() => refresh()}>
          Refresh
        </button>
      </div>

      {AsyncResult.match(sessions, {
        onInitial: () => <p className={styles.hint}>Loading sessions...</p>,
        onFailure: (failure) => (
          <p className={styles.error}>
            Failed to load sessions: {failureMessage(failure.cause, "Something went wrong")}
          </p>
        ),
        onSuccess: (success) =>
          success.value.sessions.length === 0 ? (
            <p className={styles.hint}>No sessions yet.</p>
          ) : (
            <ul className={styles.list}>
              {success.value.sessions.map((session) => (
                <li key={`${session.name}/${session.id}`}>
                  <button
                    type="button"
                    className={isActive(session) ? `${styles.session} ${styles.active}` : styles.session}
                    onClick={() => setSession({ name: session.name, id: session.id })}
                  >
                    <span className={styles.sessionKey}>
                      {session.name}/{session.id}
                    </span>
                    <span className={styles.sessionTime}>{formatRelativeTime(session.lastActiveAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ),
      })}

      <form className={styles.form} onSubmit={handleCreate}>
        <div className={styles.fields}>
          <input
            className={styles.input}
            placeholder="name"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            aria-label="New session name"
          />
          <input
            className={styles.input}
            placeholder="id"
            value={newId}
            onChange={(event) => setNewId(event.target.value)}
            aria-label="New session id"
          />
        </div>
        <button type="submit" className={styles.create} disabled={!nameValid || !idValid}>
          New session
        </button>
      </form>

      <label className={styles.picker}>
        <span className={styles.pickerLabel}>Model</span>
        <input
          className={styles.input}
          list="flue-models"
          placeholder="session default"
          value={model}
          onChange={(event) => setModel(event.target.value)}
        />
        <datalist id="flue-models">
          <option value="tencent/hy3:free" />
          <option value="openai/gpt-4o-mini" />
        </datalist>
      </label>
    </aside>
  )
}
