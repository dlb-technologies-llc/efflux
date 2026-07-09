import type { JournalEventPayload as JournalEventPayloadType } from "@effect-flue/shared"
import { JournalApprovalResolved, JournalEventPayload, Message } from "@effect-flue/shared"
import { DurableObject } from "cloudflare:workers"
import { Effect, Result, Schema } from "effect"

/** Legacy pre-journal history blob shape (KV key "history"), read only by the constructor's one-shot seed migration. */
const HistorySchema = Schema.Array(Message)

const decodeHistory = Schema.decodeUnknownEffect(HistorySchema)
const decodeEventPayload = Schema.decodeUnknownEffect(JournalEventPayload)
/** Synchronous decode so `resolveApproval`'s check-and-insert stays await-free (atomic). */
const decodeEventPayloadSync = Schema.decodeUnknownSync(JournalEventPayload)
const encodeEventPayload = Schema.encodeSync(JournalEventPayload)

/** Plain, RPC-safe message shape derived from the Message schema's encoded side. */
type PlainMessage = typeof Message.Encoded

/** Validated shape of the container's `POST /exec` response, checked before it crosses the RPC fence. */
const ExecResultSchema = Schema.Struct({
  exitCode: Schema.Number,
  stdout: Schema.String,
  stderr: Schema.String,
})

type ExecResult = (typeof ExecResultSchema)["Type"]

const decodeExecResult = Schema.decodeUnknownResult(ExecResultSchema)

/**
 * Per-session storage + sandbox Durable Object: holds the append-only event journal
 * (DO SQLite) and the sandbox exec/hydrate seam. RPC fence — every method takes/returns
 * plain structuredClone-able objects (no Schema.Class); journal payloads cross as JSON strings.
 */
export class Agent extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS journal (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL
      )`,
    )
    ctx.blockConcurrencyWhile(async () => {
      const count = ctx.storage.sql
        .exec("SELECT COUNT(*) AS n FROM journal")
        .one()
      if (Number(count.n) > 0) return
      const raw = await ctx.storage.get("history")
      if (raw === undefined) return
      try {
        const legacy = await Effect.runPromise(decodeHistory(raw))
        const now = Date.now()
        let lastTurn = 0
        for (const message of legacy) {
          if (message.role === "user") {
            lastTurn = this.#insert(
              now,
              "user-message",
              JSON.stringify({ _tag: "user-message", content: message.content }),
            )
          } else {
            this.#insert(
              now,
              "assistant-text",
              JSON.stringify({
                _tag: "assistant-text",
                turn: lastTurn,
                hop: 0,
                text: message.content,
              }),
            )
          }
        }
        await ctx.storage.delete("history")
      } catch (error) {
        console.error(
          "journal seed from legacy history blob failed; starting empty",
          error,
        )
      }
    })
  }

  /** Insert one already-validated Encoded-JSON payload verbatim; returns the assigned monotonic seq. */
  #insert(createdAt: number, tag: string, json: string): number {
    const row = this.ctx.storage.sql
      .exec(
        "INSERT INTO journal (created_at, type, payload) VALUES (?, ?, ?) RETURNING seq",
        createdAt,
        tag,
        json,
      )
      .one()
    return Number(row.seq)
  }

  /** Upsert this session into the registry; failures are logged, never turn-fatal (the index heals on the next user message). */
  async #registerSession(at: number): Promise<void> {
    try {
      const full = this.ctx.id.name
      if (full === undefined) return
      const slash = full.indexOf("/")
      if (slash === -1) return
      const registry = this.env.REGISTRY.get(
        this.env.REGISTRY.idFromName("global"),
      )
      await registry.register({
        name: full.slice(0, slash),
        id: full.slice(slash + 1),
        at,
      })
    } catch (error) {
      console.error("session registry upsert failed", error)
    }
  }

  /**
   * Append a batch of JSON-encoded journal events atomically (one RPC per hop), returning the
   * assigned seqs in input order; a `user-message` also upserts this session into the registry.
   */
  async appendEvents(payloads: ReadonlyArray<string>): Promise<Array<number>> {
    const now = Date.now()
    const seqs: Array<number> = []
    let sawUserMessage = false
    for (const raw of payloads) {
      const decoded: JournalEventPayloadType = await Effect.runPromise(
        decodeEventPayload(JSON.parse(raw)).pipe(Effect.orDie),
      )
      seqs.push(this.#insert(now, decoded._tag, raw))
      if (decoded._tag === "user-message") sawUserMessage = true
    }
    if (sawUserMessage) await this.#registerSession(now)
    return seqs
  }

  /**
   * Resolve a pending tool approval, appending an approval-resolved event and returning plain
   * data for the handler to rebuild the continuation prompt. The check-and-insert is synchronous
   * (no await) so concurrent approves cannot both pass the already-resolved check.
   */
  async resolveApproval(input: {
    eventId: number
    approved: boolean
    reason?: string
  }): Promise<
    | { status: "ok"; turn: number; approvalId: string; toolCallId: string }
    | { status: "not-found" }
    | { status: "not-approval-event" }
    | { status: "already-resolved" }
  > {
    const row = this.ctx.storage.sql
      .exec("SELECT payload FROM journal WHERE seq = ?", input.eventId)
      .toArray()[0]
    if (row === undefined) return { status: "not-found" }
    const decoded = decodeEventPayloadSync(JSON.parse(String(row.payload)))
    if (decoded._tag !== "approval-requested") {
      return { status: "not-approval-event" }
    }
    const alreadyResolved = this.ctx.storage.sql
      .exec(
        "SELECT 1 FROM journal WHERE type = 'approval-resolved' AND json_extract(payload, '$.approvalId') = ? LIMIT 1",
        decoded.approvalId,
      )
      .toArray()
    if (alreadyResolved.length > 0) return { status: "already-resolved" }
    const resolved = new JournalApprovalResolved({
      turn: decoded.turn,
      approvalId: decoded.approvalId,
      approved: input.approved,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    })
    this.#insert(
      Date.now(),
      "approval-resolved",
      JSON.stringify(encodeEventPayload(resolved)),
    )
    return {
      status: "ok",
      turn: decoded.turn,
      approvalId: decoded.approvalId,
      toolCallId: decoded.toolCallId,
    }
  }

  /**
   * Page of raw journal rows after `after`, oldest first; payloads stay JSON strings across the
   * RPC fence. `nextAfter` is the next-page cursor, or null when this page is the last.
   */
  async readJournal(input: { after: number; limit: number }): Promise<{
    events: Array<{
      seq: number
      createdAt: number
      type: string
      payload: string
    }>
    nextAfter: number | null
  }> {
    const rows = this.ctx.storage.sql
      .exec(
        "SELECT seq, created_at, type, payload FROM journal WHERE seq > ? ORDER BY seq LIMIT ?",
        input.after,
        input.limit,
      )
      .toArray()
    const events = rows.map((row) => ({
      seq: Number(row.seq),
      createdAt: Number(row.created_at),
      type: String(row.type),
      payload: String(row.payload),
    }))
    const last = events[events.length - 1]
    return {
      events,
      nextAfter:
        events.length === input.limit && last !== undefined ? last.seq : null,
    }
  }

  /**
   * History as a fold over journal events grouped by turn (never by seq adjacency — concurrent
   * prompts interleave appends): each turn's user message, then its `assistant-text` concatenated.
   */
  async history(): Promise<Array<PlainMessage>> {
    const rows = this.ctx.storage.sql
      .exec(
        "SELECT seq, payload FROM journal WHERE type IN ('user-message', 'assistant-text') ORDER BY seq",
      )
      .toArray()
    type Turn = { userContent: string | undefined; texts: Array<string> }
    const turns = new Map<number, Turn>()
    const order: Array<number> = []
    for (const row of rows) {
      const decoded: JournalEventPayloadType = await Effect.runPromise(
        decodeEventPayload(JSON.parse(String(row.payload))).pipe(Effect.orDie),
      )
      if (decoded._tag === "user-message") {
        const key = Number(row.seq)
        turns.set(key, { userContent: decoded.content, texts: [] })
        order.push(key)
      } else if (decoded._tag === "assistant-text") {
        const existing = turns.get(decoded.turn)
        if (existing !== undefined) {
          existing.texts.push(decoded.text)
        } else {
          turns.set(decoded.turn, {
            userContent: undefined,
            texts: [decoded.text],
          })
          order.push(decoded.turn)
        }
      }
    }
    const out: Array<PlainMessage> = []
    for (const key of order) {
      const turn = turns.get(key)
      if (turn === undefined) continue
      if (turn.userContent !== undefined) {
        out.push({ role: "user", content: turn.userContent })
      }
      const text = turn.texts.join("")
      if (text.length > 0) out.push({ role: "assistant", content: text })
    }
    return out
  }

  /** Read the session's stored config overrides (empty object when none set). Plain object across the RPC fence — the handler owns schema validation. */
  async getConfig(): Promise<unknown> {
    const raw = await this.ctx.storage.get(Agent.#CONFIG_KEY)
    return raw === undefined ? {} : JSON.parse(String(raw))
  }

  /** Persist the session's config overrides verbatim (already validated at the HTTP edge); replaces any previously stored overrides. */
  async putConfig(config: unknown): Promise<void> {
    await this.ctx.storage.put(Agent.#CONFIG_KEY, JSON.stringify(config))
  }

  /** Clean-slate reset: clears the journal, dirty flag, config overrides, R2 snapshot, and a live container's /workspace. */
  async reset(): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM journal")
    await this.ctx.storage.delete("history")
    await this.ctx.storage.delete(Agent.#DIRTY_KEY)
    await this.ctx.storage.delete(Agent.#CONFIG_KEY)
    const name = this.ctx.id.name
    if (name === undefined) return
    await this.env.SESSIONS.delete(Agent.#workspaceKey(name))
    try {
      const sandbox = this.env.SANDBOX.get(this.env.SANDBOX.idFromName(name))
      const response = await sandbox.fetch("http://sandbox/reset", { method: "POST" })
      if (!response.ok) {
        console.error(`container reset failed ${response.status}: ${await response.text()}`)
      }
    } catch (error) {
      console.error("container reset failed (workspace clears on next hydrate)", error)
    }
  }

  /** DO-storage key for the workspace dirty flag (storage-backed so DO eviction can't drop it mid-turn). */
  static readonly #DIRTY_KEY = "workspaceDirty"

  /** DO-storage key for the session's config overrides (plain JSON string; schema lives at the HTTP edge). */
  static readonly #CONFIG_KEY = "config"

  /** In-flight hydration, deduping concurrent execs so they can't double-restore; cleared on settle. */
  #hydrating: Promise<void> | undefined

  /** The Sandbox DO for this session, derived from this Agent's name so it always lands on the same container. */
  #sandbox(): { sandbox: DurableObjectStub; name: string } {
    const name = this.ctx.id.name
    if (name === undefined) {
      throw new Error(
        "Agent DO id has no name — sandbox exec requires a getByName-derived id",
      )
    }
    return {
      sandbox: this.env.SANDBOX.get(this.env.SANDBOX.idFromName(name)),
      name,
    }
  }

  static #workspaceKey(name: string): string {
    return `workspaces/${name}.tar.gz`
  }

  /** Restore-on-wake: if the container isn't hydrated, pull the session's R2 snapshot (empty when none) before any command runs; any failure throws so a good snapshot can't be clobbered. */
  async #hydrate(sandbox: DurableObjectStub, name: string): Promise<void> {
    const status = await sandbox.fetch("http://sandbox/status")
    const statusText = await status.text()
    if (!status.ok) {
      throw new Error(`sandbox status failed ${status.status}: ${statusText}`)
    }
    const parsed: unknown = JSON.parse(statusText)
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Reflect.get(parsed, "hydrated") === true
    ) {
      return
    }
    const object = await this.env.SESSIONS.get(Agent.#workspaceKey(name))
    const body = object === null ? undefined : await object.arrayBuffer()
    const restore = await sandbox.fetch("http://sandbox/restore", {
      method: "POST",
      ...(body !== undefined ? { body } : {}),
    })
    if (!restore.ok) {
      throw new Error(
        `workspace restore failed ${restore.status}: ${await restore.text()}`,
      )
    }
  }

  #ensureHydrated(sandbox: DurableObjectStub, name: string): Promise<void> {
    if (this.#hydrating === undefined) {
      this.#hydrating = this.#hydrate(sandbox, name).finally(() => {
        this.#hydrating = undefined
      })
    }
    return this.#hydrating
  }

  /**
   * Snapshot the workspace to R2 if any command ran since the last snapshot; the dirty flag clears
   * before the fetch and re-sets on failure so a concurrent exec's dirty mark isn't wiped.
   */
  async snapshotIfDirty(): Promise<{ snapshotted: boolean }> {
    const dirty = await this.ctx.storage.get(Agent.#DIRTY_KEY)
    if (dirty !== true) return { snapshotted: false }
    await this.ctx.storage.delete(Agent.#DIRTY_KEY)
    try {
      const { sandbox, name } = this.#sandbox()
      const response = await sandbox.fetch("http://sandbox/snapshot")
      if (!response.ok) {
        throw new Error(
          `workspace snapshot failed ${response.status}: ${await response.text()}`,
        )
      }
      const bytes = await response.arrayBuffer()
      await this.env.SESSIONS.put(Agent.#workspaceKey(name), bytes)
      return { snapshotted: true }
    } catch (e) {
      await this.ctx.storage.put(Agent.#DIRTY_KEY, true)
      throw e
    }
  }

  /** Run one command in the session's sandbox; spawn-level failures never throw — they map to `{exitCode: -1, ...}` so Bash reports them in-band. */
  async exec(command: string): Promise<ExecResult> {
    try {
      const { sandbox, name } = this.#sandbox()
      await this.#ensureHydrated(sandbox, name)
      await this.ctx.storage.put(Agent.#DIRTY_KEY, true)
      const response = await sandbox.fetch("http://sandbox/exec", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command }),
      })
      const text = await response.text()
      if (!response.ok) {
        return {
          exitCode: -1,
          stdout: "",
          stderr: `sandbox responded ${response.status}: ${text}`,
        }
      }
      const decoded = decodeExecResult(JSON.parse(text))
      if (Result.isFailure(decoded)) {
        return {
          exitCode: -1,
          stdout: "",
          stderr: `sandbox returned malformed exec result: ${text}`,
        }
      }
      return decoded.success
    } catch (e) {
      return {
        exitCode: -1,
        stdout: "",
        stderr: e instanceof Error ? e.message : String(e),
      }
    }
  }
}
