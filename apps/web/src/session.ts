import { Atom } from "effect/unstable/reactivity"

/** Session coordinates: `name` + `id` form the Durable-Object-backed session key on the Worker. */
export interface SessionArgs {
  readonly name: string
  readonly id: string
}

const initialSession: SessionArgs = { name: "support", id: "default" }

/** The session every panel currently targets; the SessionSwitcher writes it, all panels read it. */
export const currentSessionAtom = Atom.make(initialSession)

/** Per-request model override forwarded as `PromptRequest.model`; empty string means "use the session default". */
export const selectedModelAtom = Atom.make("")

/** Per-request skill overlay forwarded as `PromptRequest.skill`; empty string means no skill overlay. */
export const selectedSkillAtom = Atom.make("")

/** Monotonic counter bumped after any turn or approval mutates the journal; JournalTimeline watches it to refetch (no server push). */
export const journalVersionAtom = Atom.make(0)
