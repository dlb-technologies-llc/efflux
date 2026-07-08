// Bash sandbox HTTP server — runs INSIDE the container. The socket is served
// by Bun.serve (the CF→container boundary); everything the routes DO is Effect
// (an HttpRouter served via toWebHandler). The exec/tar OS I/O lives in
// Effect-wrapped boundary helpers, the same seam pattern as the Worker's
// readBody. The Sandbox Durable Object forwards requests here on port 8080.
//
// Error contract: nothing fails across `/exec` — spawn failures, malformed
// bodies, and non-string commands all respond HTTP 200 with
// `{exitCode: -1, stdout: "", stderr: <message>}`. A command that runs and
// exits non-zero is NOT an error. The durable-workspace routes
// (`/status`, `/restore`, `/snapshot`, `/reset`) use real HTTP status codes.
//
// NOTE: this image bundles `effect` (see package.json) — a deliberate size /
// cold-start cost so the container is an Effect app like the rest of the stack.

import { Effect, Result } from "effect"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"

// All commands run here; snapshot/restore tar exactly this directory. Created
// and chowned to `bun` in the Dockerfile, separate from /app so a snapshot
// never captures server.ts itself.
const WORKSPACE = "/workspace"

// In-memory hydration marker. Container death resets it — that reset IS the
// "workspace needs restoring from R2" signal the Agent DO reads via GET /status.
let hydrated = false

interface ExecResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

const execFailure = (message: string): ExecResult => ({ exitCode: -1, stdout: "", stderr: message })

// Per-command wall-clock ceiling; runaways (`sleep 600`, `yes`, busy-loops) are
// SIGTERM'd at expiry and reported in-band. Accepted gap: SIGTERM hits the `sh`
// child, so a deliberately backgrounded grandchild (`cmd &`) can outlive it.
const TIMEOUT_MS = 120_000
// Hard cumulative (stdout+stderr) output ceiling, enforced by draining the
// pipes as streams. Stops a `yes` / `cat /dev/urandom` flood from OOMing the
// container. Safety backstop; Tools.ts applies the smaller ~30k prompt cap.
const MAX_OUTPUT_BYTES = 1_000_000
const TRUNCATION_MARKER = "\n[output truncated at 1MB]"

// OS-process I/O boundary (Bun.spawn + Web streams). Never rejects — maps every
// failure into the in-band ExecResult shape; wrapped in Effect by the handler.
const runCommand = async (command: string): Promise<ExecResult> => {
  const proc = Bun.spawn(["sh", "-c", command], { cwd: WORKSPACE, stdout: "pipe", stderr: "pipe" })
  let timedOut = false
  let truncated = false
  let totalBytes = 0
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, TIMEOUT_MS)
  const drain = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    const decoder = new TextDecoder()
    const reader = stream.getReader()
    let out = ""
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      const remaining = MAX_OUTPUT_BYTES - totalBytes
      if (remaining <= 0) {
        truncated = true
        proc.kill()
        continue
      }
      if (value.byteLength > remaining) {
        out += decoder.decode(value.subarray(0, remaining), { stream: true })
        totalBytes += remaining
        truncated = true
        proc.kill()
      } else {
        out += decoder.decode(value, { stream: true })
        totalBytes += value.byteLength
      }
    }
    out += decoder.decode()
    return out
  }
  try {
    const [exitCode, stdout, stderr] = await Promise.all([proc.exited, drain(proc.stdout), drain(proc.stderr)])
    clearTimeout(timer)
    if (timedOut) return { exitCode: -1, stdout, stderr: "command timed out after 120s" }
    if (truncated) return { exitCode, stdout: stdout + TRUNCATION_MARKER, stderr }
    return { exitCode, stdout, stderr }
  } catch (error) {
    clearTimeout(timer)
    return execFailure(error instanceof Error ? error.message : `Sandbox exec failed: ${String(error)}`)
  }
}

const restoreWorkspace = async (bytes: ArrayBuffer): Promise<{ ok: true } | { error: string }> => {
  if (bytes.byteLength === 0) return { ok: true }
  const proc = Bun.spawn(["tar", "-xzf", "-", "-C", WORKSPACE], {
    stdin: new Uint8Array(bytes),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stderr] = await Promise.all([proc.exited, proc.stderr.text()])
  return exitCode === 0 ? { ok: true } : { error: `tar extract failed (exit ${exitCode}): ${stderr}` }
}

const snapshotWorkspace = async (): Promise<{ bytes: Uint8Array } | { error: string }> => {
  const proc = Bun.spawn(["tar", "-czf", "-", "-C", WORKSPACE, "."], { stdout: "pipe", stderr: "pipe" })
  const [buf, exitCode, stderr] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    proc.exited,
    proc.stderr.text(),
  ])
  return exitCode === 0 ? { bytes: new Uint8Array(buf) } : { error: `tar create failed (exit ${exitCode}): ${stderr}` }
}

// Wipe /workspace contents (dotfiles included), best-effort — backs the Agent
// DO's reset() clean-slate contract.
const resetWorkspace = async (): Promise<void> => {
  await Bun.spawn(["sh", "-c", "rm -rf /workspace/* /workspace/.[!.]* 2>/dev/null || true"], {
    cwd: WORKSPACE,
  }).exited
}

const handleExec = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function*() {
    const bodyText = yield* Effect.result(request.text)
    if (Result.isFailure(bodyText)) {
      return yield* HttpServerResponse.json(execFailure("could not read request body"))
    }
    const parsed = yield* Effect.result(Effect.try(() => JSON.parse(bodyText.success)))
    if (Result.isFailure(parsed)) {
      return yield* HttpServerResponse.json(execFailure("request body must be JSON"))
    }
    const value: unknown = parsed.success
    const command =
      typeof value === "object" && value !== null && "command" in value && typeof value.command === "string"
        ? value.command
        : undefined
    if (command === undefined) {
      return yield* HttpServerResponse.json(execFailure("`command` must be a string"))
    }
    const result = yield* Effect.promise(() => runCommand(command))
    return yield* HttpServerResponse.json(result)
  })

const handleRestore = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function*() {
    const bytes = yield* Effect.result(request.arrayBuffer)
    if (Result.isFailure(bytes)) {
      return HttpServerResponse.text("could not read restore body", { status: 500 })
    }
    const result = yield* Effect.promise(() => restoreWorkspace(bytes.success))
    if ("error" in result) return HttpServerResponse.text(result.error, { status: 500 })
    yield* Effect.sync(() => {
      hydrated = true
    })
    return yield* HttpServerResponse.json({ ok: true })
  })

// Refuses until hydrated: a snapshot of a fresh container must never overwrite
// a good R2 object.
const handleSnapshot = Effect.gen(function*() {
  if (!hydrated) return HttpServerResponse.text("workspace not hydrated; refusing to snapshot", { status: 409 })
  const result = yield* Effect.promise(() => snapshotWorkspace())
  if ("error" in result) return HttpServerResponse.text(result.error, { status: 500 })
  return HttpServerResponse.uint8Array(result.bytes, {
    headers: { "content-type": "application/octet-stream" },
  })
})

const handleReset = Effect.gen(function*() {
  yield* Effect.promise(() => resetWorkspace())
  yield* Effect.sync(() => {
    hydrated = false
  })
  return yield* HttpServerResponse.json({ ok: true })
})

const routerLayer = HttpRouter.addAll([
  HttpRouter.route("POST", "/exec", handleExec),
  HttpRouter.route("GET", "/status", Effect.suspend(() => HttpServerResponse.json({ hydrated }))),
  HttpRouter.route("POST", "/restore", handleRestore),
  HttpRouter.route("GET", "/snapshot", handleSnapshot),
  HttpRouter.route("POST", "/reset", handleReset),
  HttpRouter.route("GET", "/", Effect.succeed(HttpServerResponse.text("Sandbox container (POST /exec)"))),
])

const { handler } = HttpRouter.toWebHandler(routerLayer, { disableLogger: true })

const portEnv = Bun.env.PORT
const port = portEnv !== undefined && portEnv !== "" ? Number(portEnv) : 8080

Bun.serve({
  port,
  // Bun's default idleTimeout (~10s) would sever /exec for any command longer
  // than the idle window. 0 disables it; the per-command TIMEOUT_MS in
  // runCommand bounds a single exec (with Cloudflare's request limits behind).
  idleTimeout: 0,
  fetch: (request) => handler(request),
})

console.log(`Sandbox container listening on port ${port}`)
