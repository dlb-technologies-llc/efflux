import type {
  MemoryDeleteResult,
  MemoryWriteResult,
  PlainMemoryEntry,
  PlainMemorySummary,
} from "@efflux/shared"
import {
  MEMORY_MAX_CONTENT_LENGTH,
  MEMORY_MAX_DESCRIPTION_LENGTH,
  MEMORY_MAX_ENTRIES,
} from "@efflux/shared"
import { DurableObject } from "cloudflare:workers"
import { Context, Effect } from "effect"
import { formatMemoryIndex } from "./MemoryStore.ts"

/**
 * Cross-session memory Durable Object — one instance per agent NAME
 * (`idFromName(<agentName>)`), so every session of that agent name shares the
 * same store (DO single-threading serializes concurrent writers).
 * The RPC boundary requires structuredClone-able values, so methods take/return
 * plain objects, and cap violations are reported in-band via `MemoryWriteResult`
 * rather than thrown across the fence.
 */
export class Memory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS memories (
        name TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    )
  }

  async list(): Promise<Array<PlainMemorySummary>> {
    const rows = this.ctx.storage.sql
      .exec("SELECT name, description, updated_at FROM memories ORDER BY name")
      .toArray()
    return rows.map((row) => ({
      name: String(row.name),
      description: String(row.description),
      updatedAt: Number(row.updated_at),
    }))
  }

  async read(name: string): Promise<PlainMemoryEntry | null> {
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT name, description, content, created_at, updated_at
         FROM memories
         WHERE name = ?`,
        name,
      )
      .toArray()
    const row = rows[0]
    if (row === undefined) return null
    return {
      name: String(row.name),
      description: String(row.description),
      content: String(row.content),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }
  }

  /**
   * Upsert a named fact, stamping timestamps internally and preserving
   * `created_at` on update. Cap violations (description/content CHARACTER
   * limits — the same unit `PutMemoryRequest`'s `isMaxLength` checks count,
   * so multibyte input that passes the schema passes here too — or a full
   * store receiving a NEW name; upserts to existing names always pass)
   * return `{ saved: false, error, entry: null }` in-band; the success
   * path returns the written row so callers never need a read-back.
   */
  async write(input: {
    name: string
    description: string
    content: string
  }): Promise<MemoryWriteResult> {
    if (input.description.length > MEMORY_MAX_DESCRIPTION_LENGTH) {
      return {
        saved: false,
        error: `description is ${input.description.length} characters, above the ${MEMORY_MAX_DESCRIPTION_LENGTH}-character limit`,
        entry: null,
      }
    }
    if (input.content.length > MEMORY_MAX_CONTENT_LENGTH) {
      return {
        saved: false,
        error: `content is ${input.content.length} characters, above the ${MEMORY_MAX_CONTENT_LENGTH}-character limit`,
        entry: null,
      }
    }
    const existing = this.ctx.storage.sql
      .exec("SELECT created_at FROM memories WHERE name = ?", input.name)
      .toArray()
    const existingRow = existing[0]
    if (existingRow === undefined) {
      const countRow = this.ctx.storage.sql
        .exec("SELECT COUNT(*) AS n FROM memories")
        .toArray()[0]
      const count = countRow === undefined ? 0 : Number(countRow.n)
      if (count >= MEMORY_MAX_ENTRIES) {
        return {
          saved: false,
          error: `memory is full (${MEMORY_MAX_ENTRIES} entries); delete an entry before adding "${input.name}"`,
          entry: null,
        }
      }
    }
    const now = Date.now()
    this.ctx.storage.sql.exec(
      `INSERT INTO memories (name, description, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET description = excluded.description, content = excluded.content, updated_at = excluded.updated_at`,
      input.name,
      input.description,
      input.content,
      now,
      now,
    )
    return {
      saved: true,
      error: null,
      entry: {
        name: input.name,
        description: input.description,
        content: input.content,
        createdAt: existingRow === undefined ? now : Number(existingRow.created_at),
        updatedAt: now,
      },
    }
  }

  async remove(name: string): Promise<MemoryDeleteResult> {
    const deleted = this.ctx.storage.sql
      .exec("DELETE FROM memories WHERE name = ? RETURNING name", name)
      .toArray()
    return { deleted: deleted.length > 0 }
  }
}

/** Native DO namespace binding for cross-session memory; lives here (not handlers.ts) so the Agent DO and handlers share it without a cycle. */
export type MemoryNamespace = DurableObjectNamespace<Memory>

export class MemoryStub extends Context.Service<
  MemoryStub,
  MemoryNamespace
>()("api/MemoryStub") {}

/**
 * Load the agent name's formatted memory-index block for prompt injection —
 * one hop, straight to the Memory DO via the root-provided `MemoryStub`
 * (never through the session's Agent DO). BEST-EFFORT BY DESIGN: memory is a
 * nice-to-have, so any failure (a Memory DO reset, storage error, RPC
 * rejection) logs and yields `undefined` — a hiccup in the single per-name
 * Memory DO must never 500 every session of that agent name (the Registry
 * best-effort precedent). Returns `undefined` immediately when the session's
 * `memoryEnabled` config is off.
 */
export const loadMemoryIndex = Effect.fn("loadMemoryIndex")(
  function* (agent: string, enabled: boolean) {
    if (!enabled) return undefined
    const ns = yield* MemoryStub
    const stub = ns.get(ns.idFromName(agent))
    const rows = yield* Effect.promise(() => stub.list())
    return formatMemoryIndex(rows)
  },
  (effect) =>
    effect.pipe(
      Effect.tapCause((cause) => Effect.logError("memory index load failed; turn continues without memory", cause)),
      Effect.catchCause(() => Effect.succeed(undefined)),
    ),
)
