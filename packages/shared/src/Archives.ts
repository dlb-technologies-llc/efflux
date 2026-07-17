import { Schema } from "effect"
import { NonNegativeInt } from "./Schemas.ts"

/** One archived session in the eval corpus, as listed from R2 without reading the body — `name`/`id`/`closedAt` parsed from the `archives/<name>/<id>/<closedAt>/journal.json` key, `sizeBytes` from R2 object metadata. Full events come from `getArchive`. */
export class ArchiveSummary extends Schema.Class<ArchiveSummary>("ArchiveSummary")({
  name: Schema.String,
  id: Schema.String,
  closedAt: NonNegativeInt,
  sizeBytes: NonNegativeInt,
}) {}

/** The full archived-session corpus index, newest close first. */
export class ArchiveListResponse extends Schema.Class<ArchiveListResponse>("ArchiveListResponse")({
  archives: Schema.Array(ArchiveSummary),
}) {}
