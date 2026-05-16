import { Schema as Schema } from "effect"

export class AgentError extends Schema.TaggedErrorClass<AgentError>()(
  "AgentError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 500 },
) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()(
  "NotFoundError",
  {
    id: Schema.String,
  },
  { httpApiStatus: 404 },
) {}
