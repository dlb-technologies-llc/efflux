import { PutSkillRequest } from "@efflux/shared"
import { Effect } from "effect"
import { Atom } from "effect/unstable/reactivity"
import { ApiClient, runtime } from "../runtime.ts"

/** Query atom: load every skill in R2 (name + description) from `GET /skills`. */
export const skillsListAtom = runtime.atom(
  Effect.fnUntraced(function*() {
    const client = yield* ApiClient
    return yield* client.skills.listSkills()
  })(),
)

/**
 * Query atom (per-name): load one skill's full markdown from `GET /skills/:name`.
 * `Atom.family` memoises per `name`, so the fetch fires on first subscribe and a
 * later `useAtomRefresh(skillContentAtom(name))` re-runs the same atom.
 */
export const skillContentAtom = Atom.family((name: string) =>
  runtime.atom(
    Effect.fnUntraced(function*() {
      const client = yield* ApiClient
      return yield* client.skills.getSkill({ params: { name } })
    })(),
  )
)

/** Mutation fn: upsert a skill's markdown via `PUT /skills/:name`. */
export const putSkillFn = runtime.fn((args: { readonly name: string; readonly content: string }) =>
  Effect.gen(function*() {
    const client = yield* ApiClient
    return yield* client.skills.putSkill({
      params: { name: args.name },
      payload: new PutSkillRequest({ content: args.content }),
    })
  })
)

/** Mutation fn: remove a skill via `DELETE /skills/:name`. */
export const deleteSkillFn = runtime.fn((name: string) =>
  Effect.gen(function*() {
    const client = yield* ApiClient
    return yield* client.skills.deleteSkill({ params: { name } })
  })
)
