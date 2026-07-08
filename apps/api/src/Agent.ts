import { Message } from "@effect-flue/shared"
import { DurableObject } from "cloudflare:workers"
import { Effect, Result, Schema } from "effect"

const HistorySchema = Schema.Array(Message)

const decodeHistory = Schema.decodeUnknownEffect(HistorySchema)
const encodeHistory = Schema.encodeEffect(HistorySchema)

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
 * Holds the persistent message history for one agent session and reaches
 * the sandbox Container that backs the `Bash` tool. The DO RPC boundary
 * requires `structuredClone`-able values, so every method accepts and
 * returns plain objects (no `Schema.Class` instances). See ISSUES.md.
 */
export class Agent extends DurableObject<Env> {
  // Decode failures die (defect) — history corruption is a bug, not a
  // typed error the caller can recover from. Matches the previous
  // `Effect.orDie` semantics: the rejection crosses RPC as a thrown error
  // and the handler-side `Effect.promise` wrapper turns it into a defect.
  #loadHistory(): Promise<ReadonlyArray<Message>> {
    return this.ctx.storage.get("history").then((raw) =>
      raw === undefined
        ? Promise.resolve<ReadonlyArray<Message>>([])
        : Effect.runPromise(decodeHistory(raw).pipe(Effect.orDie)),
    )
  }

  async history(): Promise<Array<PlainMessage>> {
    const msgs = await this.#loadHistory()
    return msgs.map((m) => ({ role: m.role, content: m.content }))
  }

  async append(msgs: ReadonlyArray<PlainMessage>): Promise<number> {
    const existing = await this.#loadHistory()
    const updated: ReadonlyArray<Message> = [
      ...existing,
      ...msgs.map((m) => new Message({ role: m.role, content: m.content })),
    ]
    const encoded = await Effect.runPromise(
      encodeHistory(updated).pipe(Effect.orDie),
    )
    await this.ctx.storage.put("history", encoded)
    return updated.length
  }

  async reset(): Promise<void> {
    await this.ctx.storage.delete("history")
  }

  // DO-storage key for the workspace dirty flag. Storage-backed (not an
  // instance field) because the gap between a turn's last exec and the
  // turn-end snapshot contains the model's final generation — long enough
  // for routine DO eviction to drop an in-memory flag while the container
  // lives on and later sleeps with the delta unsnapshotted. Exec-seam
  // state only; unrelated to the history keys.
  static readonly #DIRTY_KEY = "workspaceDirty"

  // Deduplicates concurrent hydrations on one DO instance: two interleaved
  // execs must not double-restore. Cleared on settle so the next exec
  // re-checks `/status` (the container may have died in between).
  #hydrating: Promise<void> | undefined

  // One sandbox container per agent session: derive the Sandbox DO id from
  // this Agent's own name so `agents/<name>/<id>` always lands on the same
  // container.
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

  // Restore-on-wake: the container's in-memory `hydrated` flag resets on
  // container death, so a `hydrated: false` status IS the wake signal.
  // Pull the session's snapshot from R2 (empty restore when none exists)
  // and only then allow commands. Any failure throws — exec's try/catch
  // maps it to the in-band `exitCode: -1` shape and the command does NOT
  // run, so a good snapshot can never be clobbered by an unhydrated
  // workspace at turn-end.
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
   * Snapshot the workspace to R2 if any command ran since the last
   * snapshot. Called by the HTTP handlers in a turn-end finalizer; returns
   * a plain object (RPC fence). The dirty flag is cleared BEFORE the
   * snapshot fetch and re-set on failure — clearing after the R2 put would
   * let a concurrent turn's exec (re-setting dirty mid-snapshot) be wiped
   * by this turn's completion.
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

  // Spawn-level failures (container unreachable, malformed response, bad
  // status) never throw across RPC — they map to `{exitCode: -1, stdout:
  // "", stderr: <why>}` so the `Bash` tool reports them in-band.
  async exec(command: string): Promise<ExecResult> {
    try {
      const { sandbox, name } = this.#sandbox()
      await this.#ensureHydrated(sandbox, name)
      // Mark dirty BEFORE the exec POST: a command whose response is
      // severed may still have mutated the workspace.
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
