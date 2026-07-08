// Bash sandbox HTTP server — runs INSIDE the container (plain Bun, no Effect,
// no external deps). The Sandbox Durable Object forwards requests here on
// port 8080.
//
// Error contract (mirrors the old Sandbox.runtime.ts): nothing throws across
// the HTTP boundary. Spawn failures, malformed/missing JSON bodies, and
// non-string commands all respond HTTP 200 with
// `{exitCode: -1, stdout: "", stderr: <message>}`. A command that runs and
// exits non-zero is NOT an error — its real exitCode/stdout/stderr is
// returned.

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
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
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

const portEnv = Bun.env.PORT
const port = portEnv !== undefined && portEnv !== "" ? Number(portEnv) : 8080

Bun.serve({
  port,
  // Bun's default idleTimeout (~10s) would sever /exec responses for any
  // command that runs longer than the idle window. 0 disables it; the DO
  // fetch (and Cloudflare's own limits) bound the request instead.
  idleTimeout: 0,
  fetch: async (request) => {
    const url = new URL(request.url)
    if (request.method === "POST" && url.pathname === "/exec") {
      return handleExec(request)
    }
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Sandbox container (POST /exec)", { status: 200 })
    }
    return new Response("Not Found", { status: 404 })
  },
})

console.log(`Sandbox container listening on port ${port}`)
