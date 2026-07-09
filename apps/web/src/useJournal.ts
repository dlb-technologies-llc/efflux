import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import * as React from "react"
import { journalAtom } from "./atoms/journal.ts"
import { journalVersionAtom, type SessionArgs } from "./session.ts"

/**
 * Subscribe to a session's journal and refetch it whenever `journalVersionAtom`
 * increments (a turn or approval elsewhere mutated it). `journalAtom(session)`
 * is family-memoised, so first subscribe fetches and a session switch fetches
 * the new key on its own — only later version bumps force a refresh here, which
 * both `JournalTimeline` and `ApprovalCards` share so the fetch policy lives in
 * one place (and neither depends on the other being mounted).
 */
export const useJournal = (session: SessionArgs) => {
  const version = useAtomValue(journalVersionAtom)
  const result = useAtomValue(journalAtom(session))
  const refresh = useAtomRefresh(journalAtom(session))
  const seen = React.useRef(version)
  React.useEffect(() => {
    if (seen.current === version) return
    seen.current = version
    refresh()
  }, [version, refresh])
  return { result, refresh }
}
