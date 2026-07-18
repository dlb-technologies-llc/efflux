import { AgentConfig, COMPACTION_SUMMARY_PREFIX, JobNotifyConfig, JournalApprovalResolved, JournalEventPayload, JournalSessionClosed, Message, mergeBudget, mergeToolRule, nextCronOccurrence, SetBudgetRequest, ToolRule, type JobNotify, type JobRetry, type PlainMessage } from "@efflux/shared"
import { DurableObject } from "cloudflare:workers"
import { Effect, Result, Schema } from "effect"
import { soonestDeadline } from "./AlarmSchedule.ts"
import { buildArchive } from "./Archive.ts"
import { DEFAULT_TTL_SECONDS } from "./Defaults.ts"
import { decideAfterRun, type RunOrigin } from "./JobOutcome.ts"
import { formatEmailSubject, formatEmailText, sendSlack, type NotifyOutcome } from "./Notify.ts"
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

/** Safe decode of a scheduled job's stored `notify_config` JSON through the canonical `JobNotifyConfig` schema; a failed decode means no usable notify config (delivery is skipped, no label surfaced). */
const decodeNotifyConfig = Schema.decodeUnknownResult(JobNotifyConfig)

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
    Agent.#addColumnIfMissing(ctx, "scheduled_jobs", "notify_config", "TEXT")
    Agent.#addColumnIfMissing(ctx, "scheduled_jobs", "on_success_job_id", "TEXT")
    Agent.#addColumnIfMissing(ctx, "scheduled_jobs", "on_failure_job_id", "TEXT")
    Agent.#addColumnIfMissing(ctx, "scheduled_jobs", "retry_max", "INTEGER")
    Agent.#addColumnIfMissing(ctx, "scheduled_jobs", "retry_backoff_seconds", "INTEGER")
    Agent.#addColumnIfMissing(ctx, "scheduled_jobs", "retry_attempts", "INTEGER")
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

  /** Cumulative token + USD-cost spend across every `usage` event in the journal — the budget total the loop guard and the `/usage` endpoint read. Sums `inputTokens`+`outputTokens` (robust to rows missing `totalTokens`) and `cost`. Plain object across the RPC fence (no Schema.Class, no union). */
  async usageTotals(): Promise<{ tokens: number; cost: number }> {
    const row = this.ctx.storage.sql
      .exec(
        `SELECT
           COALESCE(SUM(json_extract(payload, '$.inputTokens')), 0) AS input,
           COALESCE(SUM(json_extract(payload, '$.outputTokens')), 0) AS output,
           COALESCE(SUM(json_extract(payload, '$.cost')), 0) AS cost
         FROM journal WHERE type = 'usage'`,
      )
      .toArray()[0]
    if (row === undefined) return { tokens: 0, cost: 0 }
    return { tokens: Number(row.input) + Number(row.output), cost: Number(row.cost) }
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

  /** Atomically set or clear the session's token/cost budget in the stored overrides (read-merge-write in a single DO request, so concurrent writes can't lose an update). `budget` is re-decoded through `SetBudgetRequest` at the fence — it crosses RPC as a plain object, and an impossible ceiling is rejected here as well as at the HTTP edge. Dies (never silently resets to `{}`) if the stored config is undecodable, so a budget change can never wipe the other overrides — mirrors `setToolRule`. */
  async setBudget(budget: { maxTotalTokens: number | null; maxCostUsd: number | null }): Promise<void> {
    const validBudget = Schema.decodeUnknownSync(SetBudgetRequest)(budget)
    const raw = await this.ctx.storage.get(Agent.#CONFIG_KEY)
    const decoded = decodeConfig(raw === undefined ? {} : JSON.parse(String(raw)))
    if (Result.isFailure(decoded)) {
      throw new Error("Cannot set budget: stored session config is undecodable")
    }
    const next = mergeBudget(decoded.success, validBudget)
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
   * `#touchActivity`). Returns `{ error }` — never throws — when validation fails: a throw here
   * would surface as an uncatchable defect through the caller's `Effect.promise`, 500-ing and
   * terminating the turn, so every failure is reported in-band and the workspace is neither
   * promoted nor inserted. With `schedule` present, a structurally-valid-but-never-occurring cron
   * (e.g. `0 0 30 2 *`, Feb 30th) passes the `CronExpression` refine yet `nextCronOccurrence`
   * yields `undefined` → `{ error }`. With `schedule` ABSENT the job is chain-only (fires solely
   * as another job's outcome-chain target): `cron_expression` is stored as the EMPTY-STRING
   * sentinel `''` (never NULL — `#backfillCronExpression` rewrites only NULL, so `''` survives
   * every boot) and `next_run_at` as the dormant sentinel `0` (holds no alarm slot; both alarm
   * readers exclude it). `retry` maps to the `retry_max`/`retry_backoff_seconds` columns (NULL
   * when unset; `retry_attempts` starts at 0). Each of `onSuccessJobId`/`onFailureJobId`, when
   * present, must already exist in this session's `scheduled_jobs` — chain config is
   * creation-time-only and ids are server-generated UUIDs, so a job can only ever point at jobs
   * created BEFORE it, making chain cycles structurally impossible.
   * `run_at_hour_utc`/`run_at_minute_utc` are written as sentinel `0` (vestigial —
   * `cron_expression` is the sole scheduling source of truth; see `#backfillCronExpression`).
   */
  async createScheduledJob(input: {
    description: string
    entrypointCommand: string
    schedule?: string
    notify?: JobNotify
    retry?: JobRetry
    onSuccessJobId?: string
    onFailureJobId?: string
  }): Promise<CreateScheduledJobResult> {
    const now = Date.now()
    let nextRunAt = 0
    let cronExpression = ""
    if (input.schedule !== undefined) {
      const next = nextCronOccurrence(input.schedule, now)
      if (next === undefined) {
        return { error: "cron expression has no future occurrence: " + input.schedule }
      }
      nextRunAt = next
      cronExpression = input.schedule
    }
    if (input.notify !== undefined) {
      const n = input.notify
      if (n.channel === "slack") {
        if (n.slackUrlSecret === undefined || !(await this.hasSecret(n.slackUrlSecret))) {
          return { error: "Slack notifications need a stored secret holding the webhook URL; request it first." }
        }
      } else {
        if (n.emailTo === undefined) {
          return { error: "Email notifications need an emailTo recipient address." }
        }
        const from: string = this.env.NOTIFY_EMAIL_FROM
        if (from === "") {
          return { error: "Email notifications are not configured on this deployment (NOTIFY_EMAIL_FROM is unset)." }
        }
      }
    }
    for (const targetId of [input.onSuccessJobId, input.onFailureJobId]) {
      if (targetId === undefined) continue
      const exists = this.ctx.storage.sql.exec("SELECT 1 FROM scheduled_jobs WHERE id = ?", targetId).toArray()
      if (exists.length === 0) {
        return { error: `chain target job ${targetId} does not exist in this session; create the downstream job first` }
      }
    }
    const id = crypto.randomUUID()
    const { hash, snapshotKey } = await this.#promoteToScheduled(id)
    this.ctx.storage.sql.exec(
      `INSERT INTO scheduled_jobs
        (id, description, entrypoint_command, run_at_hour_utc, run_at_minute_utc, cron_expression, workspace_snapshot_key, script_hash, next_run_at, approved_at, last_run_status, notify_config, on_success_job_id, on_failure_job_id, retry_max, retry_backoff_seconds, retry_attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 0)`,
      id,
      input.description,
      input.entrypointCommand,
      0,
      0,
      cronExpression,
      snapshotKey,
      hash,
      nextRunAt,
      now,
      input.notify === undefined ? null : JSON.stringify(input.notify),
      input.onSuccessJobId ?? null,
      input.onFailureJobId ?? null,
      input.retry === undefined ? null : input.retry.maxAttempts,
      input.retry === undefined ? null : input.retry.backoffSeconds,
    )
    await this.#touchActivity()
    return { id, nextRunAt }
  }

  /**
   * All scheduled jobs for this session, plain objects across the RPC fence. `paused` is derived
   * from the nullable `paused` column (NULL/0 → false, 1 → true). `retry` is a human label
   * (`up to N tries · Ns apart`), present only when both retry columns are set. `chain` is a human
   * label over the outcome-chain edges (`on success → <desc>` / `on failure → <desc>`, joined with
   * `" · "` when both are set), built from an id→description map over the already-fetched rows —
   * one query total; a target id whose row no longer exists (deleted after being chained to)
   * renders as `(missing)`. `triggered` marks a chain-only job (empty-string `cron_expression`
   * sentinel — it fires only as another job's chain target, never from a cron slot).
   */
  async listScheduledJobs(): Promise<
    Array<{
      id: string
      description: string
      entrypointCommand: string
      schedule: string
      nextRunAt: number
      approvedAt: number
      lastRunStatus: string | undefined
      notify: string | undefined
      paused: boolean
      retry: string | undefined
      chain: string | undefined
      triggered: boolean
    }>
  > {
    const rows = this.ctx.storage.sql
      .exec(
        "SELECT id, description, entrypoint_command, cron_expression, next_run_at, approved_at, last_run_status, notify_config, paused, on_success_job_id, on_failure_job_id, retry_max, retry_backoff_seconds FROM scheduled_jobs ORDER BY next_run_at = 0, next_run_at",
      )
      .toArray()
    const descriptions = new Map<string, string>()
    for (const row of rows) {
      descriptions.set(String(row.id), String(row.description))
    }
    return rows.map((row) => {
      let notify: string | undefined
      if (row.notify_config !== null) {
        const decoded = decodeNotifyConfig(JSON.parse(String(row.notify_config)))
        if (Result.isSuccess(decoded)) notify = `${decoded.success.channel} · on ${decoded.success.on}`
      }
      let retry: string | undefined
      if (row.retry_max !== null && row.retry_backoff_seconds !== null) {
        retry = `up to ${Number(row.retry_max)} tries · ${Number(row.retry_backoff_seconds)}s apart`
      }
      const edges: Array<string> = []
      if (row.on_success_job_id !== null) {
        edges.push(`on success → ${descriptions.get(String(row.on_success_job_id)) ?? "(missing)"}`)
      }
      if (row.on_failure_job_id !== null) {
        edges.push(`on failure → ${descriptions.get(String(row.on_failure_job_id)) ?? "(missing)"}`)
      }
      return {
        id: String(row.id),
        description: String(row.description),
        entrypointCommand: String(row.entrypoint_command),
        schedule: String(row.cron_expression),
        nextRunAt: Number(row.next_run_at),
        approvedAt: Number(row.approved_at),
        lastRunStatus: row.last_run_status === null ? undefined : String(row.last_run_status),
        notify,
        paused: row.paused !== null && Number(row.paused) === 1,
        retry,
        chain: edges.length === 0 ? undefined : edges.join(" · "),
        triggered: String(row.cron_expression) === "",
      }
    })
  }

  /**
   * Delete a scheduled job, best-effort reclaim its orphaned R2 snapshot, and treat the delete as
   * activity so the idle-reap deadline is freshly computed rather than a possibly long-stale one
   * armed the moment reaper suppression ends (deleting the LAST job re-enables reaping — arming an
   * old `reapAt` there could fire immediately and wipe the session; #touchActivity recomputes it
   * from `now` first). Deleting a job that is another job's chain target leaves that job with a
   * dangling `on_success_job_id`/`on_failure_job_id` reference — deliberately tolerated: the
   * chain trigger is skipped (with a `console.error` trace) at fire time, and the list surface
   * renders the edge as `(missing)`.
   */
  async deleteScheduledJob(input: { id: string }): Promise<void> {
    const row = this.ctx.storage.sql
      .exec("SELECT workspace_snapshot_key FROM scheduled_jobs WHERE id = ?", input.id)
      .toArray()[0]
    if (row === undefined) {
      this.ctx.storage.sql.exec("DELETE FROM scheduled_jobs WHERE id = ?", input.id)
    } else {
      await this.#deleteJobAndReclaim(input.id, String(row.workspace_snapshot_key), "deleteScheduledJob")
    }
    await this.#touchActivity()
  }

  /** Delete one scheduled_jobs row and best-effort reclaim its promoted R2 workspace snapshot — a reclaim failure is logged as an orphaned object, never thrown. Single source shared by the explicit delete and every exhausted-schedule path (busy-skip and post-run) so the three delete-and-reclaim sites cannot drift. */
  async #deleteJobAndReclaim(id: string, workspaceSnapshotKey: string, logContext: string): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM scheduled_jobs WHERE id = ?", id)
    try {
      await this.env.SESSIONS.delete(workspaceSnapshotKey)
    } catch (error) {
      console.error(`${logContext}: snapshot delete failed (orphaned R2 object)`, error)
    }
  }

  /** Pause a scheduled job: it stops firing but retains all config (command, schedule, snapshot, run history). Idempotent — a missing or already-paused id is a no-op. Re-arms the single DO alarm (via #rearmAlarm) so the now-paused job's deadline no longer holds an alarm slot; NOT treated as conversational activity, so the idle-reap TTL window is untouched. A paused row still suppresses idle-reaping (see #rearmAlarm). */
  async pauseScheduledJob(input: { id: string }): Promise<void> {
    this.ctx.storage.sql.exec("UPDATE scheduled_jobs SET paused = 1 WHERE id = ?", input.id)
    await this.#rearmAlarm()
  }

  /** Resume a paused scheduled job. A chain-only job (empty-string `cron_expression` sentinel) has no cron slot to recompute; it returns to its resting DORMANT state — `next_run_at` reset to the sentinel 0 and `retry_attempts` to 0 — so it fires only when next triggered by a chain. Resetting `next_run_at` here is load-bearing: a retry armed before the pause leaves a real future/past deadline in `next_run_at`, and simply flipping `paused` off would re-arm an already-elapsed deadline and fire the job immediately on resume — violating the resume contract (jobs never fire immediately on resume). Discarding a pending retry on resume is intended: pause means "stop firing," and a chain-only job's resting state is dormant. A cron job fires again on its existing schedule: `next_run_at` is RECOMPUTED from the cron expression relative to NOW (the next upcoming slot) — missed occurrences during the pause are skipped and the job does NOT fire immediately on resume — and because that recompute abandons any retry cycle armed before the pause, `retry_attempts` is reset to 0 alongside it (otherwise the next failure would read stale attempts and burn retry budget it never used). One consequence of abandoning a retry cycle on pause/resume: a scheduled failure whose retry cycle had not yet reached its final try emits no deferred failure notification (notify fires only on `final`) — an accepted, narrow gap, since that failure was transient and would have been retried. Idempotent AND resume-only: a missing id OR a job that is not currently paused (`paused` NULL/0) is a no-op — so a stale/double-submitted resume on an already-active job can never shift its schedule past an imminent fire. Defensive: a cron with no future occurrence (unreachable for any job that passed creation validation, since a recurring expression always recurs within the ~9-year horizon) leaves the job paused rather than arming a past deadline. */
  async resumeScheduledJob(input: { id: string }): Promise<void> {
    const row = this.ctx.storage.sql
      .exec("SELECT cron_expression, paused FROM scheduled_jobs WHERE id = ?", input.id)
      .toArray()[0]
    if (row === undefined) return
    if (row.paused === null || Number(row.paused) !== 1) return
    if (String(row.cron_expression) === "") {
      this.ctx.storage.sql.exec("UPDATE scheduled_jobs SET paused = 0, next_run_at = 0, retry_attempts = 0 WHERE id = ?", input.id)
      await this.#rearmAlarm()
      return
    }
    const next = nextCronOccurrence(String(row.cron_expression), Date.now())
    if (next === undefined) {
      console.error("resumeScheduledJob: schedule has no future occurrence; leaving paused", input.id)
      return
    }
    this.ctx.storage.sql.exec("UPDATE scheduled_jobs SET paused = 0, next_run_at = ?, retry_attempts = 0 WHERE id = ?", next, input.id)
    await this.#rearmAlarm()
  }

  /**
   * Manually fire one scheduled job immediately, independent of its schedule: look the job up, run it
   * through the SAME `#runScheduledJob` Runner path the alarm uses (with origin `"manual"`), then
   * return the run just recorded (via {@link getLastRun}). Deliberately touches NEITHER
   * `next_run_at`/the alarm NOR the `paused` flag — a manual "run now" neither reschedules the job
   * nor un-pauses it, so a paused job can be test-fired without resuming it. Per the decision table,
   * a manual run never retries and never reschedules (the engine's `keep` verdict for `origin
   * "manual"` leaves `next_run_at` AND `retry_attempts` untouched — a pending retry cycle, if any,
   * survives the poke and still fires on its own deadline). The outcome chain DOES fire: the cascade
   * runs sequentially inside `#runScheduledJob`'s post-run sequence, BEFORE this method returns — so
   * a manual run of a deep pipeline holds the response for the whole cascade (chains are acyclic and
   * small in practice; the alarm path awaits the same sequential cascade). Returns `undefined`
   * when the id no longer exists (deleted between listing and the click) OR when a run for this job
   * is already in flight (`#runScheduledJob`'s guard short-circuits) — the handler maps either to a
   * null run. Because the guard forbids overlapping runs of the same job AND is held through the
   * entire post-run sequence, `getLastRun` here is unambiguously the clicked job's own run we just
   * triggered, not a racing one. Return is a plain object identical to `getLastRun`'s, so it crosses
   * the DO RPC fence unchanged.
   */
  async runScheduledJobNow(input: { id: string }): Promise<
    { startedAt: number; finishedAt: number; exitCode: number; stdoutExcerpt: string; stderrExcerpt: string } | undefined
  > {
    const row = this.ctx.storage.sql
      .exec("SELECT id, entrypoint_command, workspace_snapshot_key FROM scheduled_jobs WHERE id = ?", input.id)
      .toArray()[0]
    if (row === undefined) return undefined
    const ran = await this.#runScheduledJob(
      {
        id: String(row.id),
        entrypointCommand: String(row.entrypoint_command),
        workspaceSnapshotKey: String(row.workspace_snapshot_key),
      },
      "manual",
    )
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
   * ANY scheduled_jobs row (paused, dormant, or active) suppresses reaping entirely — a session
   * holding a scheduled feature, even a paused or dormant one, is not idle, so its stored reapAt is
   * left untouched. The armed deadline, however, is the soonest ACTIVE job run — a row that is not
   * paused AND has `next_run_at > 0`: paused jobs never hold an alarm slot, and neither do dormant
   * chain-only rows (`next_run_at = 0` — they fire only via a chain trigger; arming to 0 would fire
   * an instantly-due alarm whose due query finds nothing → re-arm → infinite spin). A session whose
   * only rows are paused and/or dormant therefore keeps its state but arms NO alarm (deleteAlarm).
   * Only once there are ZERO rows does the stored reapAt (if any) govern the alarm.
   *
   * INTENDED TRADEOFF, not a leak: a paused-only (or dormant-only) session is deliberately
   * immortal — reaping it would archive-and-purge the DO (see `close`), destroying the exact config
   * (command, schedule, promoted snapshot, run history) that pausing/chain-only dormancy exists to
   * retain. This is the same immortal-until-deleted property any ACTIVE scheduled job already has
   * (the any-row reap guard predates pause/resume) — and strictly cheaper, since a paused or
   * dormant session runs no Runner containers. The only cleanup paths are an explicit resume
   * (re-arms) or delete (drops the last row, re-enabling reaping via the #touchActivity in
   * deleteScheduledJob). A bounded max-pause TTL, if ever wanted, would be a separate feature.
   */
  async #rearmAlarm(): Promise<void> {
    const rows = this.ctx.storage.sql.exec("SELECT next_run_at, paused FROM scheduled_jobs").toArray()
    if (rows.length > 0) {
      const activeDeadlines = rows
        .filter((r) => (r.paused === null || Number(r.paused) === 0) && Number(r.next_run_at) > 0)
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
   * DO alarm handler: dispatches any scheduled jobs due now, then re-arms to whatever deadline is
   * next. It snapshots the due IDS once, then RE-VALIDATES each row against its CURRENT state
   * immediately before dispatch (re-SELECT; skip if the row is gone, now paused, or no longer due
   * — `next_run_at` not in `(0, now]`). This is load-bearing: an earlier iteration's chain cascade
   * can advance a later due row's schedule (a chain target that is ALSO independently cron-due runs
   * ONCE, via the chain, then the re-validation skips its scheduled slot) or delete it (an exhausted
   * chain target), and dispatching a stale snapshot row would otherwise run it a second time — or
   * against an already-reclaimed empty workspace. The loop ONLY dispatches — `#runScheduledJob`'s
   * post-run sequence owns ALL rescheduling (cron advance, retry arming, dormancy, exhausted-delete),
   * and its guard-skip path recomputes a busy row's schedule, so every dispatched row's `next_run_at`
   * is advanced, dormanted, or deleted before the dispatch returns (the totality invariant on
   * `#runScheduledJob`). The due query excludes `next_run_at = 0`: that is the dormant chain-only
   * sentinel, and without the exclusion a dormant row would read as forever-due and hot-loop the
   * alarm. If no job was due, this firing must be the reap deadline — archive-and-purge the session
   * (reaped sessions feed the eval corpus), unless a schedule appeared in the meantime (defensive
   * guard; #rearmAlarm never arms to reapAt while scheduled_jobs has rows, so this shouldn't happen
   * in practice). The trailing `#rearmAlarm` after the dispatch loop is redundant with post-run's own
   * unconditional re-arm but harmless — kept as a belt-and-braces guarantee that a dispatching alarm
   * always re-arms.
   */
  async alarm(): Promise<void> {
    const now = Date.now()
    const dueIds = this.ctx.storage.sql
      .exec("SELECT id FROM scheduled_jobs WHERE next_run_at <= ? AND next_run_at > 0 AND (paused IS NULL OR paused = 0) ORDER BY next_run_at", now)
      .toArray()
    if (dueIds.length > 0) {
      this.#alarmBatchRan = new Set<string>()
      try {
        for (const dueRow of dueIds) {
          if (this.#alarmBatchRan.has(String(dueRow.id))) continue
          const row = this.ctx.storage.sql
            .exec(
              "SELECT id, entrypoint_command, workspace_snapshot_key, next_run_at, paused FROM scheduled_jobs WHERE id = ?",
              String(dueRow.id),
            )
            .toArray()[0]
          if (row === undefined) continue
          if (row.paused !== null && Number(row.paused) === 1) continue
          const nextRunAt = Number(row.next_run_at)
          if (!(nextRunAt > 0 && nextRunAt <= now)) continue
          await this.#runScheduledJob(
            {
              id: String(row.id),
              entrypointCommand: String(row.entrypoint_command),
              workspaceSnapshotKey: String(row.workspace_snapshot_key),
            },
            "schedule",
          )
        }
      } finally {
        this.#alarmBatchRan = undefined
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

  /** Ids already fired in the CURRENT `alarm()` batch — a fresh Set for the duration of one alarm firing, `undefined` at every other time. It guarantees each job runs AT MOST ONCE per alarm tick even when it is BOTH independently cron-due AND reached via a chain trigger in the same tick (a job with its own cron that is also another job's `onSuccessJobId`/`onFailureJobId`): whichever reach lands second — the due-snapshot dispatch or the chain trigger — is skipped, so it never double-runs (two billed Runner cold-starts, duplicated side effects) regardless of processing order. `run-now` leaves this `undefined`, so a manual cascade is unaffected. */
  #alarmBatchRan: Set<string> | undefined

  /**
   * Dispatch one scheduled job on a fresh `Runner`: restore its dedicated workspace snapshot,
   * export any referenced secrets, run the entrypoint command, record the run, then execute the
   * post-run sequence driven by {@link decideAfterRun}. `Runner` cold-starts on every invocation
   * (unlike the long-lived `Sandbox`), so `/restore` and `/exec` each get one retry for a
   * cold-start-shaped failure. `/snapshot` is never called — the Runner's disk is meant to be
   * discarded, not persisted.
   *
   * `origin` records how this dispatch was started (`"schedule"` = alarm/retry, `"manual"` =
   * run-now, `"chain"` = another job's outcome trigger) and feeds the decision engine.
   *
   * GUARD LIFETIME: the job stays in `#runningJobs` through the ENTIRE post-run sequence —
   * releasing it is the very last thing (outer `finally`). Releasing earlier would let a run-now
   * double-submit start an overlapping run and would break `runScheduledJobNow`'s "getLastRun is
   * unambiguously the run we just triggered" invariant. Busy-skip: a dispatch for a job already
   * in `#runningJobs` returns `false` without running — but when `origin === "schedule"` it FIRST
   * recomputes the row's schedule (empty-cron sentinel → dormant `next_run_at = 0`; real cron →
   * next occurrence; no future occurrence → delete row + best-effort snapshot reclaim — each
   * resetting `retry_attempts` to 0, abandoning the interrupted retry cycle) so the still-due row
   * cannot hot-loop the alarm.
   *
   * POST-RUN SEQUENCE (runs after the run outcome is captured — success, failure, or caught
   * error — with the guard still held): (1) re-SELECT the job row for FRESH config; row gone
   * (deleted mid-run) → skip all post-run work (the run is already recorded via `#recordJobRun`).
   * (2) Apply the decision's scheduling SQL — `retry` arms `next_run_at`/`retry_attempts`;
   * `final` with a `cron`/`dormant` reschedule resets attempts and advances/dormants `next_run_at`
   * (an `exhausted` row is NOT deleted yet; a `keep` reschedule — manual run-now only — is a true
   * no-op that touches neither `next_run_at` nor `retry_attempts`, so a pending retry cycle survives
   * a manual poke untouched). (3) On `final` only, deliver the outcome notification best-effort — it MUST
   * precede the exhausted delete because `#deliverNotification` re-SELECTs the row and silently
   * no-ops on a deleted job; an uncaught notify throw would propagate through the chain recursion
   * into `alarm()` and trigger Cloudflare's alarm-retry storm (duplicate billed runs). (4) On
   * `final` + `exhausted`, delete the row + best-effort snapshot reclaim. (5) On `final` with a
   * `chainTargetId`, trigger the target sequentially via `await this.#runScheduledJob(target,
   * "chain")` — the chain graph is acyclic by construction (creation-time-only chain config over
   * server-generated UUIDs); a missing target, a paused target (`paused` means "stop firing
   * automatically"), a busy target, or a target that already fired in this same alarm tick (the
   * `#alarmBatchRan` per-tick dedup — a `false` return either way) is skipped with a `console.error`
   * — never a silently dropped trigger — and the whole trigger is wrapped best-effort. (6) `#rearmAlarm()`
   * unconditionally — LOAD-BEARING: a retry armed from a run-now cascade (origin `"chain"` under
   * a manual parent) writes `next_run_at = now + backoff`, but `runScheduledJobNow` never re-arms
   * the alarm — in a pure chain-only pipeline NO alarm exists at all, so without this call that
   * retry would silently never fire.
   *
   * TOTALITY INVARIANT: every `origin "schedule"` dispatch must advance, dormant, or delete
   * `next_run_at` on ALL return paths, or the alarm hot-loops on a due row — covered by the
   * busy-skip recompute, the post-run decision SQL, and the row-gone skip (a deleted row is no
   * longer due). The `name === undefined` early return is unreachable for alarm-driven dispatch
   * on a named DO.
   */
  async #runScheduledJob(
    job: {
      id: string
      entrypointCommand: string
      workspaceSnapshotKey: string
    },
    origin: RunOrigin,
  ): Promise<boolean> {
    const name = this.ctx.id.name
    if (name === undefined) return false
    if (this.#alarmBatchRan?.has(job.id)) return false
    if (this.#runningJobs.has(job.id)) {
      if (origin === "schedule") {
        const busy = this.ctx.storage.sql
          .exec("SELECT cron_expression FROM scheduled_jobs WHERE id = ?", job.id)
          .toArray()[0]
        if (busy !== undefined) {
          const cron = String(busy.cron_expression)
          if (cron === "") {
            this.ctx.storage.sql.exec("UPDATE scheduled_jobs SET next_run_at = 0, retry_attempts = 0 WHERE id = ?", job.id)
          } else {
            const next = nextCronOccurrence(cron, Date.now())
            if (next === undefined) {
              await this.#deleteJobAndReclaim(job.id, job.workspaceSnapshotKey, "busy-skip: exhausted-job")
            } else {
              this.ctx.storage.sql.exec("UPDATE scheduled_jobs SET next_run_at = ?, retry_attempts = 0 WHERE id = ?", next, job.id)
            }
          }
        }
      }
      return false
    }
    const startedAt = Date.now()
    const runner = this.env.RUNNER.get(this.env.RUNNER.idFromName(`${name}:${job.id}`))
    this.#runningJobs.add(job.id)
    this.#alarmBatchRan?.add(job.id)
    let capturedRun: { exitCode: number; startedAt: number; finishedAt: number; stdoutExcerpt: string; stderrExcerpt: string } | undefined
    try {
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
        capturedRun = { exitCode, startedAt, finishedAt: Date.now(), stdoutExcerpt, stderrExcerpt }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.#recordJobRun(job.id, startedAt, -1, "", message, `error: ${message.slice(0, 200)}`)
        capturedRun = { exitCode: -1, startedAt, finishedAt: Date.now(), stdoutExcerpt: "", stderrExcerpt: message }
      } finally {
        try {
          await runner.destroyContainer()
        } catch (error) {
          console.error("runner destroy failed", error)
        }
      }
      if (capturedRun !== undefined) {
        const row = this.ctx.storage.sql
          .exec(
            "SELECT cron_expression, retry_max, retry_backoff_seconds, COALESCE(retry_attempts, 0) AS retry_attempts, on_success_job_id, on_failure_job_id FROM scheduled_jobs WHERE id = ?",
            job.id,
          )
          .toArray()[0]
        if (row !== undefined) {
          const decision = decideAfterRun({
            exitCode: capturedRun.exitCode,
            origin,
            cronExpression: String(row.cron_expression),
            retry:
              row.retry_max !== null && row.retry_backoff_seconds !== null
                ? { maxAttempts: Number(row.retry_max), backoffSeconds: Number(row.retry_backoff_seconds) }
                : undefined,
            attemptsUsed: Number(row.retry_attempts),
            onSuccessJobId: row.on_success_job_id === null ? undefined : String(row.on_success_job_id),
            onFailureJobId: row.on_failure_job_id === null ? undefined : String(row.on_failure_job_id),
            nowMs: Date.now(),
          })
          if (decision._tag === "retry") {
            this.ctx.storage.sql.exec(
              "UPDATE scheduled_jobs SET retry_attempts = ?, next_run_at = ? WHERE id = ?",
              decision.attemptsUsed,
              decision.nextRunAt,
              job.id,
            )
          } else {
            if (decision.reschedule._tag === "cron") {
              this.ctx.storage.sql.exec(
                "UPDATE scheduled_jobs SET retry_attempts = 0, next_run_at = ? WHERE id = ?",
                decision.reschedule.nextRunAt,
                job.id,
              )
            } else if (decision.reschedule._tag === "dormant") {
              this.ctx.storage.sql.exec("UPDATE scheduled_jobs SET retry_attempts = 0, next_run_at = 0 WHERE id = ?", job.id)
            }
            try {
              await this.#deliverNotification(job.id, capturedRun)
            } catch (error) {
              console.error("scheduled-job notify failed", error)
            }
            if (decision.reschedule._tag === "exhausted") {
              await this.#deleteJobAndReclaim(job.id, job.workspaceSnapshotKey, "post-run: exhausted-job")
            }
            if (decision.chainTargetId !== undefined) {
              try {
                const target = this.ctx.storage.sql
                  .exec(
                    "SELECT id, entrypoint_command, workspace_snapshot_key, paused FROM scheduled_jobs WHERE id = ?",
                    decision.chainTargetId,
                  )
                  .toArray()[0]
                if (target === undefined) {
                  console.error(`chain trigger skipped: target job ${decision.chainTargetId} no longer exists (source ${job.id})`)
                } else if (target.paused !== null && Number(target.paused) === 1) {
                  console.error(`chain trigger skipped: target job ${decision.chainTargetId} is paused (source ${job.id})`)
                } else {
                  const triggered = await this.#runScheduledJob(
                    {
                      id: String(target.id),
                      entrypointCommand: String(target.entrypoint_command),
                      workspaceSnapshotKey: String(target.workspace_snapshot_key),
                    },
                    "chain",
                  )
                  if (!triggered) {
                    console.error(`chain trigger skipped: target job ${decision.chainTargetId} already running or already fired this alarm tick (source ${job.id})`)
                  }
                }
              } catch (error) {
                console.error("chain trigger failed", error)
              }
            }
          }
          await this.#rearmAlarm()
        }
      }
    } finally {
      this.#runningJobs.delete(job.id)
    }
    return true
  }

  /** Best-effort outcome notification for the run just captured by #runScheduledJob. Reads the job's description + stored notify config, applies its filter, resolves the target, and delivers via Slack or the Email Service. Takes the captured run outcome directly (never getLastRun) so a concurrent run can't swap it. Never throws internally on a delivery decision; the caller wraps it best-effort. */
  async #deliverNotification(
    jobId: string,
    run: { exitCode: number; startedAt: number; finishedAt: number; stdoutExcerpt: string; stderrExcerpt: string },
  ): Promise<void> {
    const row = this.ctx.storage.sql.exec("SELECT description, notify_config FROM scheduled_jobs WHERE id = ?", jobId).toArray()[0]
    if (row === undefined || row.notify_config === null) return
    const decoded = decodeNotifyConfig(JSON.parse(String(row.notify_config)))
    if (Result.isFailure(decoded)) return
    const config = decoded.success
    if (config.on === "failure" && run.exitCode === 0) return
    const outcome: NotifyOutcome = {
      description: String(row.description),
      status: run.exitCode === 0 ? "ok" : `failed (exit ${run.exitCode})`,
      exitCode: run.exitCode,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      stdoutExcerpt: run.stdoutExcerpt,
      stderrExcerpt: run.stderrExcerpt,
    }
    if (config.channel === "slack") {
      if (config.slackUrlSecret === undefined) return
      const url = await this.#getSecretValue(config.slackUrlSecret)
      if (url === undefined) {
        console.error(`scheduled-job notify skipped: slack secret '${config.slackUrlSecret}' not found`)
        return
      }
      await sendSlack(url, outcome)
    } else {
      if (config.emailTo === undefined) return
      if (this.env.NOTIFY_EMAIL_FROM === "") {
        console.error("scheduled-job notify skipped: NOTIFY_EMAIL_FROM is unset")
        return
      }
      await this.env.EMAIL.send({
        to: config.emailTo,
        from: this.env.NOTIFY_EMAIL_FROM,
        subject: formatEmailSubject(outcome),
        text: formatEmailText(outcome),
      })
    }
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

  /** Coerce one `scheduled_job_runs` row into the plain run-detail object both `getLastRun` and `listRuns` return across the RPC fence — NULL excerpt columns become `""`. One place so a column/coercion change can't drift the two run shapes apart. */
  static #rowToRun(
    row: Record<string, SqlStorageValue>,
  ): { startedAt: number; finishedAt: number; exitCode: number; stdoutExcerpt: string; stderrExcerpt: string } {
    return {
      startedAt: Number(row.started_at),
      finishedAt: Number(row.finished_at),
      exitCode: Number(row.exit_code),
      stdoutExcerpt: row.stdout_excerpt === null ? "" : String(row.stdout_excerpt),
      stderrExcerpt: row.stderr_excerpt === null ? "" : String(row.stderr_excerpt),
    }
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
    return row === undefined ? undefined : Agent.#rowToRun(row)
  }

  /** Every stored run of one scheduled job, most recent first — capped at `#MAX_RUNS_PER_JOB` by the recorder's prune, empty when it hasn't fired yet. Plain array across the RPC fence (no Schema.Class, no union — structuredClone-safe). */
  async listRuns(jobId: string): Promise<
    Array<{ startedAt: number; finishedAt: number; exitCode: number; stdoutExcerpt: string; stderrExcerpt: string }>
  > {
    const rows = this.ctx.storage.sql
      .exec(
        "SELECT started_at, finished_at, exit_code, stdout_excerpt, stderr_excerpt FROM scheduled_job_runs WHERE job_id = ? ORDER BY started_at DESC",
        jobId,
      )
      .toArray()
    return rows.map((row) => Agent.#rowToRun(row))
  }
}
