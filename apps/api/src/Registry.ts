import type { SessionInfo } from "@efflux/shared"
import { DurableObject } from "cloudflare:workers"
import { Context } from "effect"

/** Plain RPC-safe row shape from SessionInfo's encoded side — no parallel type to drift from the wire contract. */
type SessionRow = typeof SessionInfo.Encoded

/**
 * Session registry Durable Object — a singleton (`idFromName("global")`) indexing
 * every session so `GET /agents` can enumerate without touching each session DO.
 * The RPC boundary requires structuredClone-able values, so methods take/return plain objects.
 */
export class Registry extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS sessions (
        name TEXT NOT NULL,
        id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL,
        PRIMARY KEY (name, id)
      )`,
    )
  }

  async register(input: {
    name: string
    id: string
    at: number
  }): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO sessions (name, id, created_at, last_active_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (name, id) DO UPDATE SET last_active_at = excluded.last_active_at`,
      input.name,
      input.id,
      input.at,
      input.at,
    )
  }

  async unregister(input: { name: string; id: string }): Promise<void> {
    this.ctx.storage.sql.exec(
      "DELETE FROM sessions WHERE name = ? AND id = ?",
      input.name,
      input.id,
    )
  }

  async list(input?: { limit?: number }): Promise<Array<SessionRow>> {
    const requested = input?.limit ?? 100
    const limit = Math.min(500, Math.max(1, Math.trunc(requested)))
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT name, id, created_at, last_active_at
         FROM sessions
         ORDER BY last_active_at DESC
         LIMIT ?`,
        limit,
      )
      .toArray()
    return rows.map((row) => ({
      name: String(row.name),
      id: String(row.id),
      createdAt: Number(row.created_at),
      lastActiveAt: Number(row.last_active_at),
    }))
  }
}

/** Native DO namespace binding for the registry; lives here (not handlers.ts) so the Agent DO and handlers share it without a cycle. */
export type RegistryNamespace = DurableObjectNamespace<Registry>

export class RegistryStub extends Context.Service<
  RegistryStub,
  RegistryNamespace
>()("api/RegistryStub") {}
