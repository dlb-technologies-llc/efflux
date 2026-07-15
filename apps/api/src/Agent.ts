import { AgentConfig, COMPACTION_SUMMARY_PREFIX, JournalApprovalResolved, JournalEventPayload, JournalSessionClosed, Message, mergeToolRule, nextCronOccurrence, ToolRule, type PlainMessage } from "@efflux/shared"
import { DurableObject } from "cloudflare:workers"
import { Effect, Result, Schema } from "effect"
import { soonestDeadline } from "./AlarmSchedule.ts"
import { buildArchive } from "./Archive.ts"
import { DEFAULT_TTL_SECONDS } from "./Defaults.ts"
import { decryptSecret, encryptSecret } from "./SecretsCrypto.ts"
import type { PlainTodo } from "./Todo.ts"
import type { CreateScheduledJobResult } from "./Tools.ts"

/** Legacy pre-journal history blob shape (KV key "history"), read only by the constructor's one-shot seed migration. */
const HistorySchema = Schema.Array(Message)

const decodeHistory = Schema.decodeUnknownEffect(HistorySchema)
/** Synchronous decode so `resolveApproval`'s check-and-insert stays await-free (atomic). */
const decodeEventPayloadSync = Schema.decodeUnknownSync(JournalEventPayload)
const encodeEventPayload = Schema.encodeSync(JournalEventPayload)

/** Validated shape of the container's `POST /exec` response, checked before it crosses the RPC fence. */
const ExecResultSchema = Schema.Struct({
  exitCode: Schema.Number,
  stdout: Schema.String,
  stderr: Schema.String,
})

type ExecResult = (typeof ExecResultSchema)["Type"]

const decodeExecResult = Schema.decodeUnknownResult(ExecResultSchema)

/** Shape of the container's `GET /status` reply; only `hydrated` is consumed (excess keys stripped on decode). */
const StatusSchema = Schema.Struct({ hydrated: Schema.Boolean })
const decodeStatus = Schema.decodeUnknownResult(StatusSchema)

/** Safe decode of the session's stored config overrides through the canonical `AgentConfig` schema; a failed decode means no usable overrides. */
const decodeConfig = Schema.decodeUnknownResult(AgentConfig)

/** Matches `{{NAME}}` secret references inside a scheduled job's entrypoint command template. */
const SECRET_REF_PATTERN = /\{\{(\w+)\}\}/g

/** POSIX single-quote escaping: wrap in '...', turning any embedded ' into '\''. Safe for arbitrary byte content, including shell metacharacters. */
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

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
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS secrets (
        name TEXT PRIMARY KEY,
        iv TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    )
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS scheduled_jobs (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        entrypoint_command TEXT NOT NULL,
        run_at_hour_utc INTEGER NOT NULL,
        run_at_minute_utc INTEGER NOT NULL,
        cron_expression TEXT,
        workspace_snapshot_key TEXT NOT NULL,
        script_hash TEXT NOT NULL,
        next_run_at INTEGER NOT NULL,
        approved_at INTEGER NOT NULL,
        last_run_status TEXT,
        paused INTEGER
      )`,
    )
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS scheduled_job_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        exit_code INTEGER,
        stdout_excerpt TEXT,
        stderr_excerpt TEXT
      )`,
    )
    Agent.#addColumnIfMissing(ctx, "scheduled_job_runs", "stdout_excerpt", "TEXT")
    Agent.#addColumnIfMissing(ctx, "scheduled_jobs", "paused", "INTEGER")
    Agent.#backfillCronExpression(ctx)
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

  /**
   * Add a column to an already-existing table, tolerating both possible states of a fresh
   * `CREATE TABLE IF NOT EXISTS` call: a brand-new table already has the column (declared
   * inline), so `ALTER TABLE ADD COLUMN` fails with "duplicate column name" — expected,
   * swallowed. An existing table predating the column genuinely lacks it, so the same
   * statement adds it for real. Without this, every DO whose table was created before a
   * later column was introduced throws `SQLITE_ERROR: no such column` on every read/write
   * that references it — `CREATE TABLE IF NOT EXISTS` alone never migrates an existing table.
   */
  static #addColumnIfMissing(ctx: DurableObjectState, table: string, column: string, sqlType: string): void {
    try {
      ctx.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${sqlType}`)
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("duplicate column name")) {
        throw error
      }
    }
  }

  /**
   * Additive migration to the cron scheduling model. Adds the nullable `cron_expression` column and
   * backfills every pre-existing row (created before this column) to its equivalent daily cron —
   * `<minute> <hour> * * *` — from the retained `run_at_minute_utc`/`run_at_hour_utc` values, so no
   * previously-scheduled job loses its schedule. From here on `cron_expression` is the SOLE
   * scheduling source of truth: `createScheduledJob` writes it and every reschedule reads it. The
   * `run_at_hour_utc`/`run_at_minute_utc` columns are retained ONLY to satisfy their `NOT NULL`
   * constraint on pre-existing tables — they are written as sentinel `0` on every new job and never
   * read again. They cannot be dropped additively (an `ALTER TABLE ... DROP COLUMN` / table rebuild
   * is out of scope), so they persist as harmless vestige. Runs synchronously, outside
   * `blockConcurrencyWhile`, immediately after the `CREATE TABLE` statements — same as the other
   * `#addColumnIfMissing` migrations.
   */
  static #backfillCronExpression(ctx: DurableObjectState): void {
    Agent.#addColumnIfMissing(ctx, "scheduled_jobs", "cron_expression", "TEXT")
    ctx.storage.sql.exec(
      "UPDATE scheduled_jobs SET cron_expression = CAST(run_at_minute_utc AS TEXT) || ' ' || CAST(run_at_hour_utc AS TEXT) || ' * * *' WHERE cron_expression IS NULL",
    )
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

  /** Remove this session from the registry; failures are logged, never fatal (the index heals on the next user message). */
  async #unregisterSession(): Promise<void> {
    try {
      const full = this.ctx.id.name
      if (full === undefined) return
      const slash = full.indexOf("/")
      if (slash === -1) return
      const registry = this.env.REGISTRY.get(
        this.env.REGISTRY.idFromName("global"),
      )
      await registry.unregister({
        name: full.slice(0, slash),
        id: full.slice(slash + 1),
      })
    } catch (error) {
      console.error("session registry delete failed", error)
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
      const decoded = decodeEventPayloadSync(JSON.parse(raw))
      seqs.push(this.#insert(now, decoded._tag, raw))
      if (decoded._tag === "user-message") sawUserMessage = true
    }
    if (sawUserMessage) {
      await this.#registerSession(now)
      await this.#touchActivity()
    }
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
    await this.#touchActivity()
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

  /** Input-token count of the most recent `usage` event — the current-context-size proxy the compaction trigger reads — or null when no turn has recorded usage yet. */
  async latestUsageTokens(): Promise<number | null> {
    const row = this.ctx.storage.sql
      .exec("SELECT payload FROM journal WHERE type = 'usage' ORDER BY seq DESC LIMIT 1")
      .toArray()[0]
    if (row === undefined) return null
    const decoded = decodeEventPayloadSync(JSON.parse(String(row.payload)))
    if (decoded._tag !== "usage") return null
    return decoded.inputTokens ?? decoded.totalTokens ?? null
  }

  /** Items of the latest `todo-write` event (empty when none), as PLAIN objects across the RPC fence (Schema.Class instances cannot cross it — see ISSUES.md). */
  async latestTodos(): Promise<Array<PlainTodo>> {
    const row = this.ctx.storage.sql
      .exec("SELECT payload FROM journal WHERE type = 'todo-write' ORDER BY seq DESC LIMIT 1")
      .toArray()[0]
    if (row === undefined) return []
    const decoded = decodeEventPayloadSync(JSON.parse(String(row.payload)))
    return decoded._tag === "todo-write"
      ? decoded.items.map((i) => ({ content: i.content, status: i.status }))
      : []
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
      const decoded = decodeEventPayloadSync(JSON.parse(String(row.payload)))
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
    const compRow = this.ctx.storage.sql
      .exec("SELECT payload FROM journal WHERE type = 'compaction' ORDER BY seq DESC LIMIT 1")
      .toArray()[0]
    let throughSeq = -1
    let summary: string | undefined
    if (compRow !== undefined) {
      const d = decodeEventPayloadSync(JSON.parse(String(compRow.payload)))
      if (d._tag === "compaction") {
        throughSeq = d.throughSeq
        summary = d.summary
      }
    }
    const out: Array<PlainMessage> = []
    if (summary !== undefined) {
      out.push({ role: "user", content: COMPACTION_SUMMARY_PREFIX + summary })
    }
    for (const key of order) {
      if (key <= throughSeq) continue
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

  /** Atomically merge one tool's gate decision into the stored overrides (read-merge-write in a single DO request, so concurrent flips can't lose an update). `rule` is re-decoded at the fence — it arrives as a plain `string` across RPC. Dies (never silently resets to `{}`) if the stored config is undecodable, so a single rule flip can never wipe the other overrides — matching the fail-loud read path in `loadResolvedConfig`. */
  async setToolRule(tool: string, rule: string): Promise<void> {
    const validRule = Schema.decodeUnknownSync(ToolRule)(rule)
    const raw = await this.ctx.storage.get(Agent.#CONFIG_KEY)
    const decoded = decodeConfig(raw === undefined ? {} : JSON.parse(String(raw)))
    if (Result.isFailure(decoded)) {
      throw new Error("Cannot set tool rule: stored session config is undecodable")
    }
    const next = mergeToolRule(decoded.success, tool, validRule)
    await this.ctx.storage.put(Agent.#CONFIG_KEY, JSON.stringify(next))
  }

  /** Encrypt and upsert a named secret; a fresh IV is generated every call, including overwrites of an existing name — an IV is never reused. Returns the row's actual `created_at` (preserved across an overwrite, never reset to the call time) so callers never report a false creation timestamp. */
  async putSecret(input: { name: string; value: string }): Promise<{ createdAt: number }> {
    const { ciphertext, iv } = await encryptSecret(this.env.SECRETS_ENCRYPTION_KEY, input.value)
    this.ctx.storage.sql.exec(
      `INSERT INTO secrets (name, iv, ciphertext, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET iv = excluded.iv, ciphertext = excluded.ciphertext`,
      input.name,
      iv,
      ciphertext,
      Date.now(),
    )
    const row = this.ctx.storage.sql.exec("SELECT created_at FROM secrets WHERE name = ?", input.name).toArray()[0]
    return { createdAt: row === undefined ? Date.now() : Number(row.created_at) }
  }

  /** Whether a secret with this name is currently stored. */
  async hasSecret(name: string): Promise<boolean> {
    const rows = this.ctx.storage.sql.exec("SELECT 1 FROM secrets WHERE name = ? LIMIT 1", name).toArray()
    return rows.length > 0
  }

  /** Names and creation times of every stored secret — NEVER the value; the value must never cross the RPC fence via this method. */
  async listSecretNames(): Promise<Array<{ name: string; createdAt: number }>> {
    const rows = this.ctx.storage.sql.exec("SELECT name, created_at FROM secrets ORDER BY name").toArray()
    return rows.map((row) => ({ name: String(row.name), createdAt: Number(row.created_at) }))
  }

  /** Delete a stored secret by name. Idempotent — a missing name is a no-op with no error. Activity-neutral like `putSecret`: never touches the reaper alarm, since secret writes are not conversational activity. */
  async deleteSecret(input: { name: string }): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM secrets WHERE name = ?", input.name)
  }

  /** Decrypt a stored secret's value. Private (real `#` field) so the raw value is structurally incapable of crossing the DO RPC fence — used only inside `#buildScheduledCommand`. */
  async #getSecretValue(name: string): Promise<string | undefined> {
    const row = this.ctx.storage.sql.exec("SELECT iv, ciphertext FROM secrets WHERE name = ?", name).toArray()[0]
    if (row === undefined) return undefined
    return decryptSecret(this.env.SECRETS_ENCRYPTION_KEY, String(row.iv), String(row.ciphertext))
  }

  /**
   * Copy the CURRENT live workspace bytes to a NEW, separate R2 key at approval time — promotion
   * is a real copy, not a pointer, so ongoing chat edits after approval can never change what's
   * already scheduled.
   */
  async #promoteToScheduled(jobId: string): Promise<{ snapshotKey: string; hash: string }> {
    await this.snapshotIfDirty()
    const name = this.ctx.id.name
    if (name === undefined) throw new Error("Agent DO id has no name")
    const object = await this.env.SESSIONS.get(Agent.#workspaceKey(name))
    const bytes = object === null ? new Uint8Array() : new Uint8Array(await object.arrayBuffer())
    const digest = await crypto.subtle.digest("SHA-256", bytes)
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
    const key = `scheduled/${name}/${jobId}/${hash}.tar.gz`
    await this.env.SESSIONS.put(key, bytes)
    return { snapshotKey: key, hash }
  }

  /**
   * Approve and create a scheduled job: computes the first `next_run_at` from the cron expression,
   * promotes the current workspace to a dedicated R2 snapshot, and re-arms the alarm (via
   * `#touchActivity`). Returns `{ error }` — never throws — when the expression has no future
   * occurrence: a structurally-valid-but-never-occurring cron (e.g. `0 0 30 2 *`, Feb 30th) passes
   * the `CronExpression` refine yet `nextCronOccurrence` yields `undefined`. A throw here would
   * surface as an uncatchable defect through the caller's `Effect.promise`, 500-ing and terminating
   * the turn, so the impossible schedule is reported in-band and the workspace is neither promoted
   * nor inserted. `run_at_hour_utc`/`run_at_minute_utc` are written as sentinel `0` (vestigial —
   * `cron_expression` is the sole scheduling source of truth; see `#backfillCronExpression`).
   */
  async createScheduledJob(input: {
    description: string
    entrypointCommand: string
    schedule: string
  }): Promise<CreateScheduledJobResult> {
    const now = Date.now()
    const nextRunAt = nextCronOccurrence(input.schedule, now)
    if (nextRunAt === undefined) {
      return { error: "cron expression has no future occurrence: " + input.schedule }
    }
    const id = crypto.randomUUID()
    const { hash, snapshotKey } = await this.#promoteToScheduled(id)
    this.ctx.storage.sql.exec(
      `INSERT INTO scheduled_jobs
        (id, description, entrypoint_command, run_at_hour_utc, run_at_minute_utc, cron_expression, workspace_snapshot_key, script_hash, next_run_at, approved_at, last_run_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      id,
      input.description,
      input.entrypointCommand,
      0,
      0,
      input.schedule,
      snapshotKey,
      hash,
      nextRunAt,
      now,
    )
    await this.#touchActivity()
    return { id, nextRunAt }
  }

  /** All scheduled jobs for this session, plain objects across the RPC fence. `paused` is derived from the nullable `paused` column (NULL/0 → false, 1 → true). */
  async listScheduledJobs(): Promise<
    Array<{
      id: string
      description: string
      entrypointCommand: string
      schedule: string
      nextRunAt: number
      approvedAt: number
      lastRunStatus: string | undefined
      paused: boolean
    }>
  > {
    const rows = this.ctx.storage.sql
      .exec(
        "SELECT id, description, entrypoint_command, cron_expression, next_run_at, approved_at, last_run_status, paused FROM scheduled_jobs ORDER BY next_run_at",
      )
      .toArray()
    return rows.map((row) => ({
      id: String(row.id),
      description: String(row.description),
      entrypointCommand: String(row.entrypoint_command),
      schedule: String(row.cron_expression),
      nextRunAt: Number(row.next_run_at),
      approvedAt: Number(row.approved_at),
      lastRunStatus: row.last_run_status === null ? undefined : String(row.last_run_status),
      paused: row.paused !== null && Number(row.paused) === 1,
    }))
  }

  /**
   * Delete a scheduled job, best-effort reclaim its orphaned R2 snapshot, and treat the delete as
   * activity so the idle-reap deadline is freshly computed rather than a possibly long-stale one
   * armed the moment reaper suppression ends (deleting the LAST job re-enables reaping — arming an
   * old `reapAt` there could fire immediately and wipe the session; #touchActivity recomputes it
   * from `now` first).
   */
  async deleteScheduledJob(input: { id: string }): Promise<void> {
    const row = this.ctx.storage.sql
      .exec("SELECT workspace_snapshot_key FROM scheduled_jobs WHERE id = ?", input.id)
      .toArray()[0]
    this.ctx.storage.sql.exec("DELETE FROM scheduled_jobs WHERE id = ?", input.id)
    if (row !== undefined) {
      try {
        await this.env.SESSIONS.delete(String(row.workspace_snapshot_key))
      } catch (error) {
        console.error("deleteScheduledJob: snapshot delete failed (orphaned R2 object)", error)
      }
    }
    await this.#touchActivity()
  }

  /** Pause a scheduled job: it stops firing but retains all config (command, schedule, snapshot, run history). Idempotent — a missing or already-paused id is a no-op. Re-arms the single DO alarm (via #rearmAlarm) so the now-paused job's deadline no longer holds an alarm slot; NOT treated as conversational activity, so the idle-reap TTL window is untouched. A paused row still suppresses idle-reaping (see #rearmAlarm). */
  async pauseScheduledJob(input: { id: string }): Promise<void> {
    this.ctx.storage.sql.exec("UPDATE scheduled_jobs SET paused = 1 WHERE id = ?", input.id)
    await this.#rearmAlarm()
  }

  /** Resume a paused scheduled job: it fires again on its existing cron schedule. `next_run_at` is RECOMPUTED from the cron expression relative to NOW (the next upcoming slot) — missed occurrences during the pause are skipped and the job does NOT fire immediately on resume. Idempotent AND resume-only: a missing id OR a job that is not currently paused (`paused` NULL/0) is a no-op — so a stale/double-submitted resume on an already-active job can never shift its schedule past an imminent fire. Defensive: a cron with no future occurrence (unreachable for any job that passed creation validation, since a recurring expression always recurs within the ~9-year horizon) leaves the job paused rather than arming a past deadline. */
  async resumeScheduledJob(input: { id: string }): Promise<void> {
    const row = this.ctx.storage.sql
      .exec("SELECT cron_expression, paused FROM scheduled_jobs WHERE id = ?", input.id)
      .toArray()[0]
    if (row === undefined) return
    if (row.paused === null || Number(row.paused) !== 1) return
    const next = nextCronOccurrence(String(row.cron_expression), Date.now())
    if (next === undefined) {
      console.error("resumeScheduledJob: schedule has no future occurrence; leaving paused", input.id)
      return
    }
    this.ctx.storage.sql.exec("UPDATE scheduled_jobs SET paused = 0, next_run_at = ? WHERE id = ?", next, input.id)
    await this.#rearmAlarm()
  }

  /**
   * Manually fire one scheduled job immediately, independent of its schedule: look the job up, run it
   * through the SAME `#runScheduledJob` Runner path the alarm uses, then return the run just recorded
   * (via {@link getLastRun}). Deliberately touches NEITHER `next_run_at`/the alarm NOR the `paused`
   * flag — a manual "run now" neither reschedules the job nor un-pauses it, so a paused job can be
   * test-fired without resuming it. Returns `undefined` when the id no longer exists (deleted between
   * listing and the click) OR when a run for this job is already in flight (`#runScheduledJob`'s guard
   * short-circuits) — the handler maps either to a null run. Because the guard forbids overlapping
   * runs of the same job, `getLastRun` here is unambiguously the run we just triggered, not a racing
   * one. Return is a plain object identical to `getLastRun`'s, so it crosses the DO RPC fence unchanged.
   */
  async runScheduledJobNow(input: { id: string }): Promise<
    { startedAt: number; finishedAt: number; exitCode: number; stdoutExcerpt: string; stderrExcerpt: string } | undefined
  > {
    const row = this.ctx.storage.sql
      .exec("SELECT id, entrypoint_command, workspace_snapshot_key FROM scheduled_jobs WHERE id = ?", input.id)
      .toArray()[0]
    if (row === undefined) return undefined
    const ran = await this.#runScheduledJob({
      id: String(row.id),
      entrypointCommand: String(row.entrypoint_command),
      workspaceSnapshotKey: String(row.workspace_snapshot_key),
    })
    if (!ran) return undefined
    return this.getLastRun(input.id)
  }

  /** Wipe all local session state — journal, dirty flag, config overrides, reaper alarm, registry entry, and the R2 workspace snapshot. The R2 delete is best-effort (logged, never thrown) so a transient bucket failure can't reject an alarm-driven `close()` and trigger an alarm-retry storm that writes duplicate archives. */
  async #wipeStorage(): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM journal")
    this.ctx.storage.sql.exec("DELETE FROM secrets")
    this.ctx.storage.sql.exec("DELETE FROM scheduled_jobs")
    this.ctx.storage.sql.exec("DELETE FROM scheduled_job_runs")
    await this.ctx.storage.delete("history")
    await this.ctx.storage.delete(Agent.#DIRTY_KEY)
    await this.ctx.storage.delete(Agent.#CONFIG_KEY)
    await this.ctx.storage.delete(Agent.#REAP_AT_KEY)
    await this.ctx.storage.deleteAlarm()
    await this.#unregisterSession()
    const name = this.ctx.id.name
    if (name === undefined) return
    try {
      await this.env.SESSIONS.delete(Agent.#workspaceKey(name))
    } catch (error) {
      console.error("wipe: workspace snapshot delete failed (orphaned R2 object)", error)
    }
  }

  /** Clean-slate reset: clears the journal, dirty flag, config overrides, R2 snapshot, and a live container's /workspace; the session stays alive (a later user message re-arms the reaper alarm). */
  async reset(): Promise<void> {
    await this.#wipeStorage()
    const name = this.ctx.id.name
    if (name === undefined) return
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

  /** DO-storage key for the armed idle-reap deadline (epoch ms) — only ever written by #touchActivity, never by #rearmAlarm, so a job firing can't silently extend it. */
  static readonly #REAP_AT_KEY = "reapAt"

  /** Real user/API activity: slide the reap deadline (sliding TTL window, same semantic as the old #scheduleReap) and re-arm. Called ONLY from appendEvents and resolveApproval — never from alarm()'s own job-dispatch path. */
  async #touchActivity(): Promise<void> {
    const raw = await this.ctx.storage.get(Agent.#CONFIG_KEY)
    const decoded = decodeConfig(raw === undefined ? {} : JSON.parse(String(raw)))
    const ttl = Result.isSuccess(decoded) ? decoded.success.ttlSeconds ?? DEFAULT_TTL_SECONDS : DEFAULT_TTL_SECONDS
    await this.ctx.storage.put(Agent.#REAP_AT_KEY, Date.now() + ttl * 1000)
    await this.#rearmAlarm()
  }

  /**
   * Re-arm the single DO alarm to the next known deadline, WITHOUT changing what that deadline is.
   * ANY scheduled_jobs row (paused or active) suppresses reaping entirely — a session holding a
   * scheduled feature, even a paused one, is not idle, so its stored reapAt is left untouched. The
   * armed deadline, however, is the soonest ACTIVE (non-paused) job run: paused jobs never hold an
   * alarm slot. A session whose only rows are paused therefore keeps its state but arms NO alarm
   * (deleteAlarm). Only once there are ZERO rows does the stored reapAt (if any) govern the alarm.
   *
   * INTENDED TRADEOFF, not a leak: a paused-only session is deliberately immortal — reaping it would
   * archive-and-purge the DO (see `close`), destroying the exact config (command, schedule, promoted
   * snapshot, run history) that pausing exists to retain. This is the same immortal-until-deleted
   * property any ACTIVE scheduled job already has (the any-row reap guard predates pause/resume) —
   * and strictly cheaper, since a paused session runs no Runner containers. The only cleanup paths
   * are an explicit resume (re-arms) or delete (drops the last row, re-enabling reaping via the
   * #touchActivity in deleteScheduledJob). A bounded max-pause TTL, if ever wanted, would be a
   * separate feature.
   */
  async #rearmAlarm(): Promise<void> {
    const rows = this.ctx.storage.sql.exec("SELECT next_run_at, paused FROM scheduled_jobs").toArray()
    if (rows.length > 0) {
      const activeDeadlines = rows
        .filter((r) => r.paused === null || Number(r.paused) === 0)
        .map((r) => Number(r.next_run_at))
      const soonest = soonestDeadline(activeDeadlines)
      if (soonest !== undefined) {
        await this.ctx.storage.setAlarm(soonest)
      } else {
        await this.ctx.storage.deleteAlarm()
      }
      return
    }
    const reapAt = await this.ctx.storage.get(Agent.#REAP_AT_KEY)
    if (reapAt === undefined) {
      await this.ctx.storage.deleteAlarm()
      return
    }
    await this.ctx.storage.setAlarm(Number(reapAt))
  }

  /**
   * DO alarm handler: dispatches any scheduled jobs due now, rescheduling each to its next cron
   * occurrence, then re-arms to whatever deadline is next. If no job was due, this firing must be
   * the reap deadline — archive-and-purge the session (reaped sessions feed the eval corpus),
   * unless a schedule appeared in the meantime (defensive guard; #rearmAlarm never arms to
   * reapAt while scheduled_jobs has rows, so this shouldn't happen in practice).
   *
   * Two reschedule guards, both load-bearing. (1) The next occurrence is computed from a FRESH
   * `Date.now()`, NOT the loop-top `now`: `#runScheduledJob` above `await`s a slow cold-start Runner,
   * so by the time it returns the loop-top `now` is stale by the run's wall time. Rescheduling a
   * sub-daily cron from that stale `now` can land `next_run_at` in the past → immediate re-fire →
   * back-to-back Runner containers (a billed-Container storm). Recomputing `now` guarantees `next` is
   * strictly after the reschedule instant. (2) A `undefined` next occurrence — an exhausted or
   * impossible schedule (unreachable for any expression that passed creation validation, since the
   * ~9-year horizon exceeds the largest real recurrence gap) — DELETEs the row rather than leaving
   * `next_run_at <= now`, which would hot-loop the alarm, and best-effort reclaims its R2 snapshot,
   * matching `deleteScheduledJob`'s no-stale-rows / no-orphaned-object intent.
   */
  async alarm(): Promise<void> {
    const now = Date.now()
    const due = this.ctx.storage.sql
      .exec("SELECT * FROM scheduled_jobs WHERE next_run_at <= ? AND (paused IS NULL OR paused = 0)", now)
      .toArray()
    if (due.length > 0) {
      for (const row of due) {
        const job = {
          id: String(row.id),
          entrypointCommand: String(row.entrypoint_command),
          workspaceSnapshotKey: String(row.workspace_snapshot_key),
        }
        await this.#runScheduledJob(job)
        const next = nextCronOccurrence(String(row.cron_expression), Date.now())
        if (next === undefined) {
          this.ctx.storage.sql.exec("DELETE FROM scheduled_jobs WHERE id = ?", row.id)
          try {
            await this.env.SESSIONS.delete(job.workspaceSnapshotKey)
          } catch (error) {
            console.error("alarm: exhausted-job snapshot delete failed (orphaned R2 object)", error)
          }
        } else {
          this.ctx.storage.sql.exec("UPDATE scheduled_jobs SET next_run_at = ? WHERE id = ?", next, row.id)
        }
      }
      await this.#rearmAlarm()
      return
    }
    const stillScheduled = this.ctx.storage.sql.exec("SELECT 1 FROM scheduled_jobs LIMIT 1").toArray()
    if (stillScheduled.length > 0) {
      await this.#rearmAlarm()
      return
    }
    await this.close({ mode: "archive", reason: "reaped" })
  }

  /** End the session: on `archive`, flush + copy the journal and workspace snapshot to `archives/<name>/<id>/<closedAt>/…`; then (both modes) destroy the container and `#wipeStorage()`. Every external step (snapshot, archive write, container destroy, workspace delete) is best-effort so a dead sandbox or R2 hiccup never rejects `close()`/`alarm()` and never leaves the DO half-wiped. The archive reads the full journal + workspace tarball into memory unpaginated — bounded in practice by session size (future: streamed archive for pathologically large sessions). */
  async close(input: { mode: "archive" | "purge"; reason: "closed" | "reaped" }): Promise<void> {
    const name = this.ctx.id.name
    const closedAt = Date.now()

    if (input.mode === "archive" && name !== undefined) {
      try {
        await this.snapshotIfDirty()
      } catch (error) {
        console.error("close: snapshot flush failed; archiving last durable workspace", error)
      }
      const closedEvent = encodeEventPayload(new JournalSessionClosed({ reason: input.reason }))
      this.#insert(closedAt, "session-closed", JSON.stringify(closedEvent))
      try {
        const slash = name.indexOf("/")
        const rows = this.ctx.storage.sql
          .exec("SELECT seq, created_at, type, payload FROM journal ORDER BY seq")
          .toArray()
          .map((row) => ({ seq: Number(row.seq), createdAt: Number(row.created_at), type: String(row.type), payload: String(row.payload) }))
        const json = buildArchive({
          name: slash === -1 ? name : name.slice(0, slash),
          id: slash === -1 ? "" : name.slice(slash + 1),
          closedAt,
          reason: input.reason,
          rows,
        })
        await this.env.SESSIONS.put(Agent.#archiveJournalKey(name, closedAt), json)
        const workspace = await this.env.SESSIONS.get(Agent.#workspaceKey(name))
        if (workspace !== null) {
          await this.env.SESSIONS.put(Agent.#archiveWorkspaceKey(name, closedAt), await workspace.arrayBuffer())
        }
      } catch (error) {
        console.error("close: archive write failed; purging session anyway", error)
      }
    }

    if (name !== undefined) {
      try {
        const sandbox = this.env.SANDBOX.get(this.env.SANDBOX.idFromName(name))
        await sandbox.destroyContainer()
      } catch (error) {
        console.error("close: container destroy failed", error)
      }
    }

    await this.#wipeStorage()
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

  static #archiveJournalKey(name: string, closedAt: number): string {
    return `archives/${name}/${closedAt}/journal.json`
  }

  static #archiveWorkspaceKey(name: string, closedAt: number): string {
    return `archives/${name}/${closedAt}/workspace.tar.gz`
  }

  /** Restore-on-wake: if the container isn't hydrated, pull the session's R2 snapshot (empty when none) before any command runs; any failure throws so a good snapshot can't be clobbered. */
  async #hydrate(sandbox: DurableObjectStub, name: string): Promise<void> {
    const status = await sandbox.fetch("http://sandbox/status")
    const statusText = await status.text()
    if (!status.ok) {
      throw new Error(`sandbox status failed ${status.status}: ${statusText}`)
    }
    const parsed = decodeStatus(JSON.parse(statusText))
    if (Result.isSuccess(parsed) && parsed.success.hydrated) {
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

  /**
   * Build the actual command sent to the Runner: one `export NAME=<quoted value>;` for every stored
   * secret whose name appears ANYWHERE in the template (word-boundary match against the raw text —
   * covers `process.env.NAME`, `$NAME`, a bare `NAME` in a curl header, and the `{{NAME}}` marker
   * alike), followed by the template with every `{{NAME}}` token replaced by a bare `$NAME`
   * shell-variable reference so an inline marker (e.g. inside an already-quoted header string) gets a
   * working substitution rather than an inert literal token. Detection deliberately does NOT require
   * the `{{NAME}}` marker specifically — an earlier version only exported a secret when the command
   * contained that exact marker, so a script written the idiomatic way (`process.env.NAME`, with no
   * marker anywhere) silently never got the variable exported and failed with an undefined key. The
   * raw secret value itself only ever appears in the `export` statement, shell-quoted; `$NAME`
   * expands from that exported variable at execution time, never re-embedding the raw value as a
   * second literal copy. A secret the session doesn't have is silently skipped (no export) rather
   * than throwing mid-schedule.
   */
  async #buildScheduledCommand(template: string): Promise<string> {
    const secretNames = await this.listSecretNames()
    const exports: Array<string> = []
    for (const { name } of secretNames) {
      if (!new RegExp(`\\b${Agent.#escapeRegExp(name)}\\b`).test(template)) continue
      const value = await this.#getSecretValue(name)
      if (value !== undefined) exports.push(`export ${name}=${shellQuote(value)};`)
    }
    const substituted = template.replace(SECRET_REF_PATTERN, (_match, name: string) => `$${name}`)
    return [...exports, substituted].join(" ")
  }

  /** Escape regex metacharacters so a secret name (bounded to `SafeName`'s alphanumeric/hyphen/underscore charset, but defensive regardless) can be used as a literal inside a `RegExp`. */
  static #escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }

  /** Job ids with a run currently in flight on this DO instance. `#runScheduledJob` refuses to start a second run for a job already running (whether the first is a manual "run now" or an alarm fire), so at most one run per job is ever live: it prevents two invocations from sharing — and tearing down — the same per-job `Runner` container, and caps billed container cold-starts per job to one. In-memory (not SQL) is correct — it only needs to hold across one awaited run within this DO instance, and an eviction that clears it also cancels the in-flight run. */
  readonly #runningJobs = new Set<string>()

  /**
   * Dispatch one scheduled job on a fresh `Runner`: restore its dedicated workspace snapshot,
   * export any referenced secrets, run the entrypoint command, and record the run. `Runner`
   * cold-starts on every invocation (unlike the long-lived `Sandbox`), so `/restore` and `/exec`
   * each get one retry for a cold-start-shaped failure. `/snapshot` is never called — the
   * Runner's disk is meant to be discarded, not persisted.
   */
  async #runScheduledJob(job: {
    id: string
    entrypointCommand: string
    workspaceSnapshotKey: string
  }): Promise<boolean> {
    const name = this.ctx.id.name
    if (name === undefined) return false
    if (this.#runningJobs.has(job.id)) return false
    this.#runningJobs.add(job.id)
    const startedAt = Date.now()
    const runner = this.env.RUNNER.get(this.env.RUNNER.idFromName(`${name}:${job.id}`))
    try {
      const snapshot = await this.env.SESSIONS.get(job.workspaceSnapshotKey)
      const body = snapshot === null ? undefined : await snapshot.arrayBuffer()
      let restore = await runner.fetch("http://runner/restore", { method: "POST", ...(body !== undefined ? { body } : {}) })
      if (!restore.ok) {
        restore = await runner.fetch("http://runner/restore", { method: "POST", ...(body !== undefined ? { body } : {}) })
      }
      if (!restore.ok) throw new Error(`runner restore failed ${restore.status}: ${await restore.text()}`)
      const command = await this.#buildScheduledCommand(job.entrypointCommand)
      let response = await runner.fetch("http://runner/exec", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command }),
      })
      if (!response.ok) {
        response = await runner.fetch("http://runner/exec", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ command }),
        })
      }
      const text = await response.text()
      const decoded = decodeExecResult(JSON.parse(text))
      const exitCode = Result.isSuccess(decoded) ? decoded.success.exitCode : -1
      const stdoutExcerpt = Result.isSuccess(decoded) ? decoded.success.stdout.slice(0, 2000) : ""
      const stderrExcerpt = Result.isSuccess(decoded)
        ? decoded.success.stderr.slice(0, 2000)
        : `malformed exec result: ${text.slice(0, 500)}`
      this.#recordJobRun(job.id, startedAt, exitCode, stdoutExcerpt, stderrExcerpt, exitCode === 0 ? "ok" : `failed (exit ${exitCode})`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#recordJobRun(job.id, startedAt, -1, "", message, `error: ${message.slice(0, 200)}`)
    } finally {
      this.#runningJobs.delete(job.id)
      try {
        await runner.destroyContainer()
      } catch (error) {
        console.error("runner destroy failed", error)
      }
    }
    return true
  }

  /** Most recent runs to retain per job in `scheduled_job_runs` — bounds otherwise-unbounded growth for a long-lived recurring schedule. */
  static readonly #MAX_RUNS_PER_JOB = 30

  /** Record one job run's outcome: insert the run-log row (stdout AND stderr, both truncated — a run's actual output was previously discarded entirely, visible nowhere), reflect its status onto `scheduled_jobs.last_run_status` (read by `listScheduledJobs`/the FE panel — previously never written, so it stayed NULL forever), and prune older runs for this job beyond `#MAX_RUNS_PER_JOB`. */
  #recordJobRun(
    jobId: string,
    startedAt: number,
    exitCode: number,
    stdoutExcerpt: string,
    stderrExcerpt: string,
    lastRunStatus: string,
  ): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO scheduled_job_runs (job_id, started_at, finished_at, exit_code, stdout_excerpt, stderr_excerpt) VALUES (?, ?, ?, ?, ?, ?)",
      jobId,
      startedAt,
      Date.now(),
      exitCode,
      stdoutExcerpt,
      stderrExcerpt,
    )
    this.ctx.storage.sql.exec("UPDATE scheduled_jobs SET last_run_status = ? WHERE id = ?", lastRunStatus, jobId)
    this.ctx.storage.sql.exec(
      `DELETE FROM scheduled_job_runs
       WHERE job_id = ? AND id NOT IN (
         SELECT id FROM scheduled_job_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?
       )`,
      jobId,
      jobId,
      Agent.#MAX_RUNS_PER_JOB,
    )
  }

  /** The most recent run of one scheduled job, or `undefined` if it hasn't run yet — plain object across the RPC fence. */
  async getLastRun(jobId: string): Promise<
    | { startedAt: number; finishedAt: number; exitCode: number; stdoutExcerpt: string; stderrExcerpt: string }
    | undefined
  > {
    const row = this.ctx.storage.sql
      .exec(
        "SELECT started_at, finished_at, exit_code, stdout_excerpt, stderr_excerpt FROM scheduled_job_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT 1",
        jobId,
      )
      .toArray()[0]
    if (row === undefined) return undefined
    return {
      startedAt: Number(row.started_at),
      finishedAt: Number(row.finished_at),
      exitCode: Number(row.exit_code),
      stdoutExcerpt: row.stdout_excerpt === null ? "" : String(row.stdout_excerpt),
      stderrExcerpt: row.stderr_excerpt === null ? "" : String(row.stderr_excerpt),
    }
  }
}
