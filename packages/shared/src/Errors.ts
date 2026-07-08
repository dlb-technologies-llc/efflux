import { Schema } from "effect"

export class AgentError extends Schema.TaggedErrorClass<AgentError>()(
  "AgentError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 500 },
) {}

export class SkillNotFoundError extends Schema.TaggedErrorClass<SkillNotFoundError>()(
  "SkillNotFoundError",
  {
    skill: Schema.String,
    key: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class RoleNotFoundError extends Schema.TaggedErrorClass<RoleNotFoundError>()(
  "RoleNotFoundError",
  {
    role: Schema.String,
    key: Schema.String,
  },
  { httpApiStatus: 404 },
) {}
