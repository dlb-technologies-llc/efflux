import { Schema } from "effect"

/** Cumulative session spend plus the resolved ceilings and whether either is tripped — the `GET /agents/:name/:id/usage` response. `max*` are null when that dimension is unlimited. */
export class SessionUsage extends Schema.Class<SessionUsage>("SessionUsage")({
  totalTokens: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  totalCost: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  maxTotalTokens: Schema.NullOr(Schema.Number),
  maxCostUsd: Schema.NullOr(Schema.Number),
  exceeded: Schema.Boolean,
}) {}
