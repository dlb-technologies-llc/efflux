import type { JournalEventPayload as JournalEventPayloadType } from "@effect-flue/shared"
import { JournalEventPayload, Message } from "@effect-flue/shared"
import { DurableObject } from "cloudflare:workers"
import { Effect, Result, Schema } from "effect"

// Legacy pre-journal history blob shape (KV key "history"). Only read by the
// one-shot seed migration in the constructor.
const HistorySchema = Schema.Array(Message)

const decodeHistory = Schema.decodeUnknownEffect(HistorySchema)
const decodeEventPayload = Schema.decodeUnknownEffect(JournalEventPayload)

type PlainMessage = { role: "user" | "assistant"; content: string }

// Shape of the container server's `POST /exec` response body. Validated
// before crossing the RPC fence so a misbehaving container can never leak
// an arbitrary object into the `Bash` tool's typed contract.
const ExecResultSchema = Schema.Struct({
  exitCode: Schema.Number,
  stdout: Schema.String,
  stderr: Schema.String,
})

type ExecResult = (typeof ExecResultSchema)["Type"]

const decodeExecResult = Schema.decodeUnknownResult(ExecResultSchema)

/**
 * Storage + sandbox Durable Object.
 *
 * Holds the append-only event journal for one agent session (DO SQLite,
 * `ctx.storage.sql`) and reaches the sandbox Container that backs the `Bash`
 * tool. History is a fold over journal events. The DO RPC boundary requires
 * `structuredClone`-able values, so every method accepts and returns plain
 * objects (no `Schema.Class` instances) — journal payloads cross the fence
 * as JSON strings. See ISSUES.md.
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
    // One-shot legacy migration: fold-on-first-read seeding of the journal
    // from the pre-journal `history` KV blob. Runs before any RPC is
    // delivered. MUST NOT throw — a corrupt blob would otherwise brick the
    // DO (including `reset()`, the recovery path): on decode failure we
    // log, leave the blob in place, and start with an empty journal.
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
            // Legacy blobs always alternate user→assistant, but guard a
            // leading assistant message: `turn: 0` matches no user row and
            // the fold's orphan branch still emits it.
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
        // Delete the blob so a later `reset()` + re-activation can never
        // re-seed stale history.
        await ctx.storage.delete("history")
      } catch (error) {
        console.error(
          "journal seed from legacy history blob failed; starting empty",
          error,
        )
      }
    })
  }

  // Insert one already-validated payload; returns the assigned monotonic
  // seq. `json` must be the schema-Encoded JSON text (stored verbatim so
  // reads decode through the same schema); `tag` comes from the validated
  // decode of that same text, so column and payload cannot disagree.
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

  // Upsert into the session registry. Failures are logged, never
  // turn-fatal — the index heals on the next user message.
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
   * Append a batch of journal events atomically (one RPC per hop). Each
   * element is a JSON-encoded `JournalEventPayload`; payloads are validated
   * before insert (failure = defect — these are our own writes, so a
   * mismatch is a bug, not a recoverable error). Returns the assigned seqs
   * in input order. A `user-message` payload also upserts this session into
   * the registry.
   */
  async appendEvents(payloads: ReadonlyArray<string>): Promise<Array<number>> {
    const now = Date.now()
    const seqs: Array<number> = []
    let sawUserMessage = false
    for (const raw of payloads) {
      const decoded: JournalEventPayloadType = await Effect.runPromise(
        decodeEventPayload(JSON.parse(raw)).pipe(Effect.orDie),
      )
      // Store the validated ENCODED text verbatim — reads decode through
      // the same schema, so the stored side must stay the Encoded side.
      seqs.push(this.#insert(now, decoded._tag, raw))
      if (decoded._tag === "user-message") sawUserMessage = true
    }
    if (sawUserMessage) await this.#registerSession(now)
    return seqs
  }

  /**
   * Page of raw journal rows after `after`, oldest first. Payloads stay
   * JSON strings across the RPC fence; the handler decodes them through the
   * shared schemas. `nextAfter` is the cursor for the next page, or null
   * when this page is the last.
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
   * History = fold over journal events, grouped by turn (NEVER by seq
   * adjacency — concurrent prompts interleave appends). Per turn: the user
   * message, then the concatenation of that turn's `assistant-text` texts
   * in seq order (no separator) when non-empty. Matches the pre-journal
   * wire shape byte-for-byte for seeded sessions.
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
          // Orphan (legacy leading-assistant or a turn whose user row was
          // filtered): key by its turn stamp so the text still folds in.
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

  /**
   * Compatibility shim for the pre-journal handlers: writes plain
   * user/assistant messages as journal events and returns the folded
   * message count. Removed once the handlers journal events directly.
   */
  async append(msgs: ReadonlyArray<PlainMessage>): Promise<number> {
    const now = Date.now()
    let lastTurn = 0
    let sawUserMessage = false
    for (const message of msgs) {
      if (message.role === "user") {
        lastTurn = this.#insert(
          now,
          "user-message",
          JSON.stringify({ _tag: "user-message", content: message.content }),
        )
        sawUserMessage = true
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
    if (sawUserMessage) await this.#registerSession(now)
    const history = await this.history()
    return history.length
  }

  async reset(): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM journal")
    // AUTOINCREMENT keeps the seq counter — ids stay monotonic across
    // resets (Last-Event-ID safe). Also drop any legacy blob a failed seed
    // left behind.
    await this.ctx.storage.delete("history")
  }

  // Spawn-level failures (container unreachable, malformed response, bad
  // status) never throw across RPC — they map to `{exitCode: -1, stdout:
  // "", stderr: <why>}` so the `Bash` tool reports them in-band.
  async exec(command: string): Promise<ExecResult> {
    try {
      const name = this.ctx.id.name
      if (name === undefined) {
        throw new Error(
          "Agent DO id has no name — sandbox exec requires a getByName-derived id",
        )
      }
      // One sandbox container per agent session: derive the Sandbox DO id
      // from this Agent's own name so `agents/<name>/<id>` always lands on
      // the same container.
      const sandbox = this.env.SANDBOX.get(this.env.SANDBOX.idFromName(name))
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
