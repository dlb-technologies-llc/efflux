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
