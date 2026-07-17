import { Schema } from "effect"
import { NonNegativeInt } from "./Schemas.ts"

/** Max bytes accepted for a single workspace upload (10 MiB). Enforced server-side by the payload schema's `isMaxLength` and pre-checked client-side before the request is built. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

const WORKSPACE_FILENAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/

/** Destination filename for a workspace upload — a BARE filename (no slashes, no leading dot), so it can only ever land directly under `/workspace`. Bounds the keyspace against path traversal exactly as `SafeName` does for R2 keys, while allowing dots/extensions (`report.pdf`). */
export const WorkspaceFilename = Schema.String.pipe(
  Schema.refine((s): s is string => WORKSPACE_FILENAME_PATTERN.test(s), {
    title: "WorkspaceFilename",
    description: "bare filename, alphanumeric/dot/hyphen/underscore, no leading dot; 1-255 chars",
  }),
)

/** Confirmation returned by a successful upload — the absolute container path the file landed at and its byte count. */
export class UploadResponse extends Schema.Class<UploadResponse>("UploadResponse")({
  path: Schema.String,
  bytes: NonNegativeInt,
}) {}
