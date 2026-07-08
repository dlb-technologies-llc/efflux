/**
 * Tools exposed to the parent prompt loop.
 *
 * Defines the tools the model can call:
 *  - `GetCurrentTime` — no-parameter clock read, returns an ISO 8601 string.
 *  - `SpawnSubagent`  — delegate a focused subtask to a stateless subagent
 *                       (no parent history, returns only final response text).
 *  - `Bash`           — arbitrary shell command in the session's sandbox
 *                       container.
 *  - `read_file` / `write_file` / `edit_file` / `glob` / `grep` — file and
 *    search operations against the container's `/workspace` (all ride the
 *    same exec seam as `Bash`; arbitrary content travels base64-encoded
 *    through env vars into `bun -e` scripts to sidestep shell quoting).
 *  - `web_fetch`      — Worker-side HTTP GET with a size cap (no container
 *                       round-trip, no extra service dependencies).
 *
 * The handlers' R-channel requirements (`LanguageModel | SkillsBucket`, via
 * `runSubagent`) bubble through `AgentToolkit.toLayer(...)` as the layer's
 * `RIn`. They are satisfied at the Worker root by `aiLayer` (Wave 1) and the
 * `SkillsBucket` layer already provided in `Api.ts`.
 *
 * Subagents intentionally have no toolkit attached, so they cannot themselves
 * spawn further subagents — see `runSubagent` for the anti-recursion note.
 */
import { SubagentTaskRequest } from "@effect-flue/shared"
import { Cause, Context, Effect, Encoding, Schema } from "effect"
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai"
import { SkillsBucket } from "./Skills.ts"
import { runSubagent } from "./Subagent.ts"

// Per-request handle to the DO's `exec(command)` RPC. Provided in the
// `prompt` and `stream` handlers from the resolved Agent stub.
export class BashRunner extends Context.Service<
  BashRunner,
  {
    readonly exec: (
      command: string,
    ) => Effect.Effect<{
      readonly exitCode: number
      readonly stdout: string
      readonly stderr: string
    }>
  }
>()("api/BashRunner") {}

export const GetCurrentTimeTool = Tool.make("GetCurrentTime", {
  description: "Returns the current UTC date and time as an ISO 8601 string.",
  // No parameters — Tool.make defaults to an empty-object schema (EmptyParams).
  success: Schema.String,
})

// Derive parameters from `SubagentTaskRequest.fields` so the tool surface
// stays in lockstep with the `POST /tasks` HTTP endpoint.
const SpawnSubagentParameters = Schema.Struct(SubagentTaskRequest.fields)

export const SpawnSubagentTool = Tool.make("SpawnSubagent", {
  description:
    "Delegate a focused subtask to a stateless subagent. The subagent has no access to this conversation's history and returns only its final response text. Use for classification, summarization, or KB lookups without polluting the parent's context.",
  parameters: SpawnSubagentParameters,
  success: Schema.String,
  // Declare the services the handler needs at construction time so the
  // handler's R-channel may legally reference them. They bubble up through
  // `AgentToolkit.toLayer(...)` as the layer's `RIn`, where the Worker root
  // satisfies them via `aiLayer` (LanguageModel) and the SkillsBucket layer.
  dependencies: [LanguageModel.LanguageModel, SkillsBucket],
})

const BashParameters = Schema.Struct({
  command: Schema.String.annotate({
    description:
      "Shell command to execute. Runs via `sh -c <command>` inside the sandboxed Linux container.",
  }),
})

const BashResult = Schema.Struct({
  exitCode: Schema.Number,
  stdout: Schema.String,
  stderr: Schema.String,
})

type BashResultValue = typeof BashResult.Type

export const BashTool = Tool.make("Bash", {
  description:
    "Execute a shell command in the sandboxed Linux container bound to this agent session. Returns the exit code, stdout, and stderr. The working directory is /workspace — a writable but EPHEMERAL scratch space, wiped when the sandbox idles out (~10 minutes) or redeploys. Use this for devops-style operations the dedicated file tools do not cover.",
  parameters: BashParameters,
  success: BashResult,
  // Declare BashRunner so the handler's R-channel may legally reference
  // it. Bubbles up through `AgentToolkit.toLayer(...)` as the layer's
  // `RIn`, satisfied per-request in `handlers.ts`.
  dependencies: [BashRunner],
})

// ---------------------------------------------------------------------------
// File & search tools (container-side, via the same exec seam as `Bash`)
// ---------------------------------------------------------------------------

/**
 * Tool results feed straight back into the prompt on the next hop, so cap
 * them — one runaway `cat` must not dwarf the rest of the context.
 */
const MAX_TOOL_OUTPUT_CHARS = 30_000

/**
 * The whole command travels as ONE `sh -c` argv string; Linux caps a single
 * argv element at MAX_ARG_STRLEN (131,072 bytes). Exceeding it surfaces as a
 * cryptic spawn failure (E2BIG → exitCode -1), so pre-empt with a clear
 * error. Commands are pure ASCII (base64 payloads), so chars == bytes here.
 */
const MAX_COMMAND_CHARS = 90_000

const EPHEMERAL_NOTE =
  "Paths resolve relative to /workspace, a writable but EPHEMERAL scratch space — contents are wiped when the sandbox idles out (~10 minutes) or redeploys."

const capText = (text: string): string =>
  text.length > MAX_TOOL_OUTPUT_CHARS
    ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n[output truncated]`
    : text

const capExecResult = (result: BashResultValue): BashResultValue => ({
  exitCode: result.exitCode,
  stdout: capText(result.stdout),
  stderr: capText(result.stderr),
})

const execCapped = (command: string): Effect.Effect<BashResultValue, never, BashRunner> =>
  BashRunner.use((runner) => runner.exec(command)).pipe(
    Effect.map(capExecResult),
  )

const commandTooLarge = (what: string): BashResultValue => ({
  exitCode: -1,
  stdout: "",
  stderr: `${what} too large for a single call (~64KB UTF-8 max) — split it into smaller pieces`,
})

// POSIX single-quote escaping for path/pattern arguments in plain shell
// commands. Arbitrary CONTENT never goes through this — it travels base64.
const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`

/**
 * Build `FLUE_X=<base64> ... bun -e '<script>'`. Base64 values are shell-safe
 * unquoted (`A-Za-z0-9+/=`); scripts must contain no single quotes (double
 * quotes only) so the outer single-quoted wrapper stays intact.
 */
const bunEval = (env: Record<string, string>, script: string): string => {
  const assignments = Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ")
  return `${assignments} bun -e '${script}'`
}

const WRITE_SCRIPT = `
const path = Buffer.from(process.env.FLUE_PATH ?? "", "base64").toString("utf8");
const data = Buffer.from(process.env.FLUE_DATA ?? "", "base64");
const n = await Bun.write(path, data);
console.log("Wrote " + n + " bytes to " + path);
`.trim()

const EDIT_SCRIPT = `
const path = Buffer.from(process.env.FLUE_PATH ?? "", "base64").toString("utf8");
const oldStr = Buffer.from(process.env.FLUE_OLD ?? "", "base64").toString("utf8");
const newStr = Buffer.from(process.env.FLUE_NEW ?? "", "base64").toString("utf8");
const replaceAll = process.env.FLUE_ALL === "1";
if (oldStr.length === 0) {
  console.error("old_string must not be empty");
  process.exit(1);
}
const file = Bun.file(path);
if (!(await file.exists())) {
  console.error("File not found: " + path);
  process.exit(1);
}
const content = await file.text();
const count = content.split(oldStr).length - 1;
if (count === 0) {
  console.error("old_string not found in " + path);
  process.exit(1);
}
if (count > 1 && !replaceAll) {
  console.error("old_string occurs " + count + " times in " + path + "; provide more surrounding context or set replace_all");
  process.exit(1);
}
const idx = content.indexOf(oldStr);
const next = replaceAll
  ? content.split(oldStr).join(newStr)
  : content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
await Bun.write(path, next);
console.log("Replaced " + (replaceAll ? count : 1) + " occurrence(s) in " + path);
`.trim()

const GLOB_SCRIPT = `
const pattern = Buffer.from(process.env.FLUE_PATTERN ?? "", "base64").toString("utf8");
const cwd = Buffer.from(process.env.FLUE_CWD ?? "", "base64").toString("utf8") || ".";
const matches = [];
for await (const m of new Bun.Glob(pattern).scan({ cwd, dot: true })) {
  matches.push(m);
}
matches.sort();
const cap = 500;
for (const m of matches.slice(0, cap)) console.log(m);
if (matches.length > cap) console.log("[+" + (matches.length - cap) + " more]");
if (matches.length === 0) console.log("(no matches)");
`.trim()

export const ReadFileTool = Tool.make("read_file", {
  description: `Read a file from the sandbox container and return its contents on stdout. ${EPHEMERAL_NOTE} Output is truncated at ${MAX_TOOL_OUTPUT_CHARS} characters. A non-zero exit code with the reason on stderr means the read failed (e.g. missing file).`,
  parameters: Schema.Struct({
    path: Schema.String.annotate({
      description: "File path to read, absolute or relative to /workspace.",
    }),
  }),
  success: BashResult,
  dependencies: [BashRunner],
})

export const WriteFileTool = Tool.make("write_file", {
  description: `Write a file in the sandbox container, creating parent directories as needed and overwriting any existing file. ${EPHEMERAL_NOTE} Content is limited to ~64KB per call — split larger writes.`,
  parameters: Schema.Struct({
    path: Schema.String.annotate({
      description: "Destination path, absolute or relative to /workspace.",
    }),
    content: Schema.String.annotate({
      description: "Full file content to write (UTF-8).",
    }),
  }),
  success: BashResult,
  dependencies: [BashRunner],
})

export const EditFileTool = Tool.make("edit_file", {
  description: `Replace an exact string in a file in the sandbox container. Fails (non-zero exit, reason on stderr) when old_string is missing, or when it is ambiguous (multiple occurrences) and replace_all is not set. ${EPHEMERAL_NOTE}`,
  parameters: Schema.Struct({
    path: Schema.String.annotate({
      description: "File to edit, absolute or relative to /workspace.",
    }),
    old_string: Schema.String.annotate({
      description:
        "Exact text to replace (must be non-empty; include enough surrounding context to be unique unless replace_all is set).",
    }),
    new_string: Schema.String.annotate({
      description: "Replacement text.",
    }),
    replace_all: Schema.optionalKey(Schema.Boolean).annotate({
      description: "Replace every occurrence instead of requiring uniqueness.",
    }),
  }),
  success: BashResult,
  dependencies: [BashRunner],
})

export const GlobTool = Tool.make("glob", {
  description: `List files in the sandbox container matching a glob pattern (supports ** and {a,b} alternates), one path per line, sorted, capped at 500 entries. ${EPHEMERAL_NOTE}`,
  parameters: Schema.Struct({
    pattern: Schema.String.annotate({
      description: 'Glob pattern, e.g. "**/*.ts" or "src/**/{a,b}/*.json".',
    }),
    path: Schema.optionalKey(Schema.String).annotate({
      description:
        "Directory to search from (defaults to the /workspace root).",
    }),
  }),
  success: BashResult,
  dependencies: [BashRunner],
})

export const GrepTool = Tool.make("grep", {
  description: `Search file contents in the sandbox container with extended regex (grep -rEIn: recursive, line numbers, binaries skipped). Exit code 1 with empty stdout means NO MATCHES — that is a normal outcome, not an error. ${EPHEMERAL_NOTE} Output is truncated at ${MAX_TOOL_OUTPUT_CHARS} characters.`,
  parameters: Schema.Struct({
    pattern: Schema.String.annotate({
      description: "Extended regular expression (POSIX ERE) to search for.",
    }),
    path: Schema.optionalKey(Schema.String).annotate({
      description:
        "File or directory to search (defaults to the /workspace root).",
    }),
  }),
  success: BashResult,
  dependencies: [BashRunner],
})

// ---------------------------------------------------------------------------
// web_fetch (Worker-side — no container round-trip, no service dependencies)
// ---------------------------------------------------------------------------

/** Network read ceiling; the returned body is further capped for the prompt. */
const MAX_FETCH_BYTES = 100_000

const WebFetchResult = Schema.Struct({
  status: Schema.Number,
  contentType: Schema.String,
  body: Schema.String,
  truncated: Schema.Boolean,
})

type WebFetchResultValue = typeof WebFetchResult.Type

export const WebFetchTool = Tool.make("web_fetch", {
  description: `Fetch a public http(s) URL from the Worker (GET, redirects followed, 15s timeout) and return the response body as text. The body is read up to ${MAX_FETCH_BYTES} bytes and the returned text is capped at ${MAX_TOOL_OUTPUT_CHARS} characters (truncated=true when cut). A status of 0 means the fetch itself failed (invalid URL, unsupported scheme, network error, or timeout) — the reason is in the body as "Error: ...".`,
  parameters: Schema.Struct({
    url: Schema.String.annotate({
      description: "Absolute http:// or https:// URL to fetch.",
    }),
  }),
  success: WebFetchResult,
})

const webFetchError = (message: string): WebFetchResultValue => ({
  status: 0,
  contentType: "",
  body: `Error: ${message}`,
  truncated: false,
})

// Modeled on the cause walk in index.ts's worker-level catchCause: surface
// the first failure/defect as readable text for the model.
const causeMessage = (cause: Cause.Cause<unknown>): string => {
  for (const reason of cause.reasons) {
    const value = Cause.isFailReason(reason)
      ? reason.error
      : Cause.isDieReason(reason)
        ? reason.defect
        : undefined
    if (value instanceof Error) return value.message
    if (value !== undefined) return String(value)
  }
  return "unknown error"
}

/**
 * Read the response body up to `MAX_FETCH_BYTES`. The reader is cancelled on
 * early exit (Workers requires bodies consumed or cancelled) and decoding is
 * streamed so a hard byte cut cannot split a multibyte character.
 */
const readBody = (
  response: Response,
): Effect.Effect<{ text: string; truncated: boolean }, Cause.UnknownError> =>
  Effect.tryPromise(async (signal) => {
    const body = response.body
    if (body === null) return { text: "", truncated: false }
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let text = ""
    let bytes = 0
    let truncated = false
    while (true) {
      if (signal.aborted) {
        await reader.cancel()
        throw new Error("fetch aborted")
      }
      const { done, value } = await reader.read()
      if (done || value === undefined) break
      bytes += value.byteLength
      text += decoder.decode(value, { stream: true })
      if (bytes >= MAX_FETCH_BYTES) {
        truncated = true
        await reader.cancel()
        break
      }
    }
    text += decoder.decode()
    return { text, truncated }
  })

const runWebFetch = (url: string): Effect.Effect<WebFetchResultValue> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try(() => new URL(url))
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return webFetchError(
        `unsupported URL scheme: ${parsed.protocol} (only http/https)`,
      )
    }
    // The AbortSignal wiring is load-bearing: without it, the timeout below
    // interrupts the effect but leaves the subrequest dangling (hanging
    // promise noise in `wrangler tail`).
    const response = yield* Effect.tryPromise((signal) =>
      fetch(url, { redirect: "follow", signal }),
    )
    const { text, truncated } = yield* readBody(response)
    const capped = text.length > MAX_TOOL_OUTPUT_CHARS
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      body: capped
        ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n[body truncated]`
        : text,
      truncated: truncated || capped,
    }
  }).pipe(
    Effect.timeout("15 seconds"),
    // Collapse ALL failures into a model-readable success value — same
    // rationale as SpawnSubagent's catch-to-text below: the model should
    // see the message and react, not fail the whole loop.
    Effect.catchCause((cause) =>
      Effect.succeed(webFetchError(causeMessage(cause))),
    ),
  )

export const AgentToolkit = Toolkit.make(
  GetCurrentTimeTool,
  SpawnSubagentTool,
  BashTool,
  ReadFileTool,
  WriteFileTool,
  EditFileTool,
  GlobTool,
  GrepTool,
  WebFetchTool,
)

export const AgentToolkitLayer = AgentToolkit.toLayer({
  GetCurrentTime: () => Effect.sync(() => new Date().toISOString()),
  SpawnSubagent: (params) =>
    runSubagent({
      prompt: params.prompt,
      ...(params.skill !== undefined ? { skill: params.skill } : {}),
      ...(params.role !== undefined ? { role: params.role } : {}),
      ...(params.model !== undefined ? { model: params.model } : {}),
    }).pipe(
      Effect.map((r) => r.text),
      // Log the typed failure so operators see it in `wrangler tail` even
      // when the model recovers gracefully. Done BEFORE the catch so the
      // log fires regardless of how we choose to surface the error.
      Effect.tapErrorTag("SkillNotFoundError", (e) =>
        Effect.logWarning(`SpawnSubagent: skill not found: ${e.skill}`),
      ),
      Effect.tapErrorTag("RoleNotFoundError", (e) =>
        Effect.logWarning(`SpawnSubagent: role not found: ${e.role}`),
      ),
      Effect.tapErrorTag("AgentError", (e) =>
        Effect.logWarning(`SpawnSubagent: agent error: ${e.message}`),
      ),
      // The Tool.Failure channel is AiError | AiErrorReason by default; we
      // collapse typed Skill/Role-not-found into success-text errors so the
      // model sees the message and can retry/apologize without failing the
      // whole loop. Exhaustive over runSubagent's typed errors via catchTags.
      Effect.catchTags({
        SkillNotFoundError: (e) =>
          Effect.succeed(`Error: Skill not found: ${e.skill}`),
        RoleNotFoundError: (e) =>
          Effect.succeed(`Error: Role not found: ${e.role}`),
        AgentError: (e) => Effect.succeed(`Error: ${e.message}`),
      }),
    ),
  Bash: (params) => BashRunner.use((runner) => runner.exec(params.command)),
  read_file: (params) => execCapped(`cat -- ${shellQuote(params.path)}`),
  write_file: (params) => {
    const command = bunEval(
      {
        FLUE_PATH: Encoding.encodeBase64(params.path),
        FLUE_DATA: Encoding.encodeBase64(params.content),
      },
      WRITE_SCRIPT,
    )
    return command.length > MAX_COMMAND_CHARS
      ? Effect.succeed(commandTooLarge("content"))
      : execCapped(command)
  },
  edit_file: (params) => {
    const command = bunEval(
      {
        FLUE_PATH: Encoding.encodeBase64(params.path),
        FLUE_OLD: Encoding.encodeBase64(params.old_string),
        FLUE_NEW: Encoding.encodeBase64(params.new_string),
        FLUE_ALL: params.replace_all === true ? "1" : "0",
      },
      EDIT_SCRIPT,
    )
    return command.length > MAX_COMMAND_CHARS
      ? Effect.succeed(commandTooLarge("old_string/new_string"))
      : execCapped(command)
  },
  glob: (params) =>
    execCapped(
      bunEval(
        {
          FLUE_PATTERN: Encoding.encodeBase64(params.pattern),
          FLUE_CWD: Encoding.encodeBase64(params.path ?? "."),
        },
        GLOB_SCRIPT,
      ),
    ),
  grep: (params) =>
    execCapped(
      `grep -rEIn -e ${shellQuote(params.pattern)} -- ${shellQuote(params.path ?? ".")}`,
    ),
  web_fetch: (params) => runWebFetch(params.url),
})
