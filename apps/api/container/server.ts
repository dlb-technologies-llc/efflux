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

const runCommand = async (command: string): Promise<ExecResult> => {
  const proc = Bun.spawn(["sh", "-c", command], {
    cwd: WORKSPACE,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    proc.stdout.text(),
    proc.stderr.text(),
  ])
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
  // command that runs longer than the idle window. 0 disables it; the DO
  // fetch (and Cloudflare's own limits) bound the request instead.
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
