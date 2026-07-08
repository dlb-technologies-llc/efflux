import { DurableObject } from "cloudflare:workers"
import { Context } from "effect"

type SessionRow = {
  name: string
  id: string
  createdAt: number
  lastActiveAt: number
}

/**
 * Session registry Durable Object — a singleton (addressed via
 * `idFromName("global")`) indexing every agent session so `GET /agents` can
 * enumerate them without touching each session DO.
 *
 * The `Agent` DO upserts here when a turn's `user-message` event is
 * journaled. The DO RPC boundary requires `structuredClone`-able values, so
 * every method accepts and returns plain objects. See ISSUES.md.
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

  async list(): Promise<Array<SessionRow>> {
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT name, id, created_at, last_active_at
         FROM sessions
         ORDER BY last_active_at DESC`,
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

// Native DO namespace binding for the registry (global type from
// worker-configuration.d.ts). Lives here rather than handlers.ts so the
// Agent DO and the handlers can both reference it without a cycle.
export type RegistryNamespace = DurableObjectNamespace<Registry>

export class RegistryStub extends Context.Service<
  RegistryStub,
  RegistryNamespace
>()("api/RegistryStub") {}
