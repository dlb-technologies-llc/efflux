// Bash sandbox HTTP server — runs INSIDE the container (plain Bun, no Effect,
// no external deps). The Sandbox Durable Object forwards requests here on
// port 8080.
//
// Error contract (mirrors the old Sandbox.runtime.ts): nothing throws across
// the HTTP boundary for `/exec`. Spawn failures, malformed/missing JSON
// bodies, and non-string commands all respond HTTP 200 with
// `{exitCode: -1, stdout: "", stderr: <message>}`. A command that runs and
// exits non-zero is NOT an error — its real exitCode/stdout/stderr is
// returned.
//
// The durable-workspace endpoints (`/status`, `/restore`, `/snapshot`) use
// real HTTP status codes instead — that in-band contract is exec-specific,
// and the Agent DO seam translates their failures.

// All commands run here, and snapshot/restore tar exactly this directory.
// Created and chowned to `bun` in the Dockerfile; deliberately separate
// from /app so a snapshot never captures server.ts itself.
const WORKSPACE = "/workspace"

// In-memory hydration marker. Container death resets it — that reset IS the
// "workspace needs restoring from R2" signal the Agent DO reads via
// `GET /status` before every exec.
let hydrated = false

interface ExecResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

const execFailure = (error: unknown): ExecResult => ({
  exitCode: -1,
  stdout: "",
  stderr:
    error instanceof Error
      ? error.message
      : `Sandbox exec failed: ${String(error)}`,
})

const json = (body: ExecResult): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })

// Per-command wall-clock ceiling. `sleep 600`, `while true; do :; done`, etc.
// are SIGTERM'd at expiry and reported as an in-band failure (never thrown).
const TIMEOUT_MS = 120_000
// Hard cumulative (stdout + stderr) output ceiling, enforced by draining the
// pipes as streams rather than buffering them whole. Stops a `yes` /
// `cat /dev/urandom` flood from OOMing the container. This is the safety
// backstop; Tools.ts applies a smaller (~30k) prompt-facing cap separately.
const MAX_OUTPUT_BYTES = 1_000_000
const TRUNCATION_MARKER = "\n[output truncated at 1MB]"

// Accepted gap: `proc.kill()` sends SIGTERM to the `sh` child, which handles
// the common runaways (`sleep`, `yes`, busy-loops). A command that
// deliberately backgrounds a grandchild (`cmd &`) can outlive the kill unless
// a fresh process group is created — out of scope here.
const runCommand = async (command: string): Promise<ExecResult> => {
  const proc = Bun.spawn(["sh", "-c", command], {
    cwd: WORKSPACE,
    stdout: "pipe",
    stderr: "pipe",
  })

  let timedOut = false
  let truncated = false
  // Shared across both drains: the ceiling is cumulative over stdout+stderr.
  // Single-threaded JS means the increments below never actually interleave.
  let totalBytes = 0

  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, TIMEOUT_MS)

  const drain = async (
    stream: ReadableStream<Uint8Array>,
  ): Promise<string> => {
    const decoder = new TextDecoder()
    const reader = stream.getReader()
    let out = ""
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      const remaining = MAX_OUTPUT_BYTES - totalBytes
      if (remaining <= 0) {
        // Already at the ceiling — keep reading to EOF so the killed process
        // unblocks, but stop accumulating.
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

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    drain(proc.stdout),
    drain(proc.stderr),
  ])
  clearTimeout(timer)

  if (timedOut) {
    return { exitCode: -1, stdout, stderr: "command timed out after 120s" }
  }
  if (truncated) {
    return { exitCode, stdout: stdout + TRUNCATION_MARKER, stderr }
  }
  return { exitCode, stdout, stderr }
}

const handleExec = async (request: Request): Promise<Response> => {
  let body: unknown
  try {
    body = await request.json()
  } catch (error) {
    return json(execFailure(error))
  }
  if (typeof body !== "object" || body === null) {
    return json(execFailure(new Error("Request body must be a JSON object")))
  }
  const command: unknown = Reflect.get(body, "command")
  if (typeof command !== "string") {
    return json(execFailure(new Error("`command` must be a string")))
  }
  try {
    return json(await runCommand(command))
  } catch (error) {
    return json(execFailure(error))
  }
}

const handleStatus = (): Response =>
  new Response(JSON.stringify({ hydrated }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })

// Body = gzipped tar of a prior workspace snapshot; empty body = "no
// snapshot exists yet, just mark hydrated". Extraction failure leaves
// `hydrated` false so the Agent seam retries (and never runs a command on
// a half-restored workspace).
const handleRestore = async (request: Request): Promise<Response> => {
  try {
    const bytes = await request.arrayBuffer()
    if (bytes.byteLength > 0) {
      const proc = Bun.spawn(["tar", "-xzf", "-", "-C", WORKSPACE], {
        stdin: new Uint8Array(bytes),
        stdout: "pipe",
        stderr: "pipe",
      })
      const [exitCode, stderr] = await Promise.all([
        proc.exited,
        proc.stderr.text(),
      ])
      if (exitCode !== 0) {
        return new Response(`tar extract failed (exit ${exitCode}): ${stderr}`, {
          status: 500,
        })
      }
    }
    hydrated = true
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : String(error),
      { status: 500 },
    )
  }
}

// Refuses until hydrated: a snapshot of a fresh (never-restored) container
// must never overwrite a good R2 object.
const handleSnapshot = async (): Promise<Response> => {
  if (!hydrated) {
    return new Response("workspace not hydrated; refusing to snapshot", {
      status: 409,
    })
  }
  try {
    const proc = Bun.spawn(["tar", "-czf", "-", "-C", WORKSPACE, "."], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [bytes, exitCode, stderr] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      proc.exited,
      proc.stderr.text(),
    ])
    if (exitCode !== 0) {
      return new Response(`tar create failed (exit ${exitCode}): ${stderr}`, {
        status: 500,
      })
    }
    return new Response(bytes, {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    })
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : String(error),
      { status: 500 },
    )
  }
}

const portEnv = Bun.env.PORT
const port = portEnv !== undefined && portEnv !== "" ? Number(portEnv) : 8080

Bun.serve({
  port,
  // Bun's default idleTimeout (~10s) would sever /exec responses for any
  // command that runs longer than the idle window. 0 disables it; the
  // per-command TIMEOUT_MS in runCommand is now what bounds how long a single
  // exec can run (with Cloudflare's own request limits behind it).
  idleTimeout: 0,
  routes: {
    "/exec": { POST: handleExec },
    "/status": { GET: handleStatus },
    "/restore": { POST: handleRestore },
    "/snapshot": { GET: handleSnapshot },
    "/": { GET: () => new Response("Sandbox container (POST /exec)", { status: 200 }) },
  },
  fetch: () => new Response("Not Found", { status: 404 }),
})

console.log(`Sandbox container listening on port ${port}`)
