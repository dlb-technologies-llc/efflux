import {
  AgentApi,
  SkillContentResponse,
  SkillListResponse,
  SkillSummary,
} from "@effect-flue/shared"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { deleteSkillObject, getSkillRaw, listSkills, putSkillBody } from "./Skills.ts"

/** Skill CRUD handlers for the `skills` group: list/read/upsert/delete R2-backed skill markdown. `SkillsBucket` is provided at the Worker root, so nothing is provided here. */
export const SkillHandlers = HttpApiBuilder.group(AgentApi, "skills", (handlers) =>
  handlers
    .handle("listSkills", () =>
      Effect.gen(function* () {
        const skills = yield* listSkills()
        return new SkillListResponse({
          skills: skills.map((s) => new SkillSummary({ name: s.name, description: s.description })),
        })
      }),
    )
    .handle("getSkill", ({ params }) =>
      Effect.gen(function* () {
        const content = yield* getSkillRaw(params.name)
        return new SkillContentResponse({ name: params.name, content })
      }),
    )
    .handle("putSkill", ({ params, payload }) =>
      Effect.gen(function* () {
        yield* putSkillBody(params.name, payload.content)
        return new SkillContentResponse({ name: params.name, content: payload.content })
      }),
    )
    .handle("deleteSkill", ({ params }) =>
      Effect.gen(function* () {
        yield* deleteSkillObject(params.name)
      }),
    ),
)
