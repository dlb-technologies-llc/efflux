import { Schema } from "effect"
import { NonNegativeInt, SafeName } from "./Schemas.ts"

/** Upsert payload for a named secret — the value never appears in any success/response schema in this file. */
export class PutSecretRequest extends Schema.Class<PutSecretRequest>("PutSecretRequest")({
  value: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
}) {}

/** Confirmation only — never echoes the value. */
export class SecretSummary extends Schema.Class<SecretSummary>("SecretSummary")({
  name: SafeName,
  createdAt: NonNegativeInt,
}) {}

export class SecretListResponse extends Schema.Class<SecretListResponse>("SecretListResponse")({
  secrets: Schema.Array(SecretSummary),
}) {}
