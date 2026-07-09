import { Schema } from "effect"

/** One skill's identity in a list — name plus the front-matter description. */
export class SkillSummary extends Schema.Class<SkillSummary>("SkillSummary")({
  name: Schema.String,
  description: Schema.String,
}) {}

/** All known skills, most relevant ordering left to the handler. */
export class SkillListResponse extends Schema.Class<SkillListResponse>("SkillListResponse")({
  skills: Schema.Array(SkillSummary),
}) {}

/** A single skill's full markdown content, keyed by name. */
export class SkillContentResponse extends Schema.Class<SkillContentResponse>("SkillContentResponse")({
  name: Schema.String,
  content: Schema.String,
}) {}

/** Upsert body for `PUT /skills/:name` — the skill's raw markdown. */
export class PutSkillRequest extends Schema.Class<PutSkillRequest>("PutSkillRequest")({
  content: Schema.String,
}) {}
