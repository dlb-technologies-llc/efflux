/**
 * Tools exposed to the parent prompt loop: clock, subagent spawn, Bash, and the
 * file/search ops (all on the same exec seam as Bash) plus Worker-side web_fetch.
 */
import {
  DEFAULT_TOOL_RULES,
  resolveRule,
  type RulesMap,
  SkillSummary,
  SubagentTaskRequest,
} from "@effect-flue/shared"
import { Cause, Context, Effect, Encoding, Schema } from "effect"
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai"
import { KnowledgeSearch, searchKnowledge } from "./Knowledge.ts"
import { listSkills, loadSkillBody, SkillsBucket } from "./Skills.ts"
import { runSubagent } from "./Subagent.ts"

/** Shape every exec-backed tool returns (Bash + file/search tools). */
const BashResult = Schema.Struct({
  exitCode: Schema.Number,
  stdout: Schema.String,
  stderr: Schema.String,
})

type BashResultValue = typeof BashResult.Type

/** Per-request handle to the DO's exec(command) RPC, provided per-request from the resolved Agent stub. */
export class BashRunner extends Context.Service<
  BashRunner,
  {
    readonly exec: (command: string) => Effect.Effect<BashResultValue>
  }
>()("api/BashRunner") {}

/** Request-scoped per-tool permission rules; each turn provides the resolved rules, defaulting to DEFAULT_TOOL_RULES. */
export const ApprovalRules = Context.Reference<RulesMap>("api/ApprovalRules", {
  defaultValue: () => DEFAULT_TOOL_RULES,
})

/** Dynamic `needsApproval`: parks the turn when this tool's resolved rule is `ask`. Reads the request-scoped ApprovalRules Reference (requirement erased — it has a default). */
const needsApprovalFor = (name: string) => (): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const rules = yield* ApprovalRules
    return resolveRule(rules, name) === "ask"
  })

/** Clock read; ask/deny rules do not gate it in v1. */
export const GetCurrentTimeTool = Tool.make("GetCurrentTime", {
  description: "Returns the current UTC date and time as an ISO 8601 string.",
  success: Schema.String,
})

/** Parameters derived from SubagentTaskRequest.fields to stay in lockstep with POST /tasks. */
const SpawnSubagentParameters = Schema.Struct(SubagentTaskRequest.fields)

/** Delegate to a stateless subagent; ask/deny rules do not gate it in v1. */
export const SpawnSubagentTool = Tool.make("SpawnSubagent", {
  description:
    "Delegate a focused subtask to a stateless subagent. The subagent has no access to this conversation's history and returns only its final response text. Use for classification, summarization, or KB lookups without polluting the parent's context.",
  parameters: SpawnSubagentParameters,
  success: Schema.String,
  dependencies: [LanguageModel.LanguageModel, SkillsBucket],
})

export const ListSkillsTool = Tool.make("list_skills", {
  description:
    "List the specialized skills available in this workspace (name + one-line description). Call this to DISCOVER skills you can then pull into context with load_skill when the user's task matches one.",
  success: Schema.Array(SkillSummary),
  dependencies: [SkillsBucket],
})

export const LoadSkillTool = Tool.make("load_skill", {
  description:
    "Load a named skill's full instructions into the conversation so you can follow them for the current task. Use list_skills first to see what's available. Returns the skill's markdown instructions, or an 'Error: ...' string if the skill does not exist.",
  parameters: Schema.Struct({
    name: Schema.String.annotate({
      description: "Skill name exactly as returned by list_skills.",
    }),
  }),
  success: Schema.String,
  dependencies: [SkillsBucket],
})

const BashParameters = Schema.Struct({
  command: Schema.String.annotate({
    description:
      "Shell command to execute. Runs via `sh -c <command>` inside the sandboxed Linux container.",
  }),
})

export const BashTool = Tool.make("Bash", {
  description:
    "Execute a shell command in the sandboxed Linux container bound to this agent session. Returns the exit code, stdout, and stderr. The working directory is /workspace — a writable but EPHEMERAL scratch space, wiped when the sandbox idles out (~10 minutes) or redeploys. Use this for devops-style operations the dedicated file tools do not cover.",
  parameters: BashParameters,
  success: BashResult,
  dependencies: [BashRunner],
  needsApproval: needsApprovalFor("Bash"),
})

/** Cap tool output — results feed back into the prompt next hop, so one runaway `cat` must not dwarf the context. */
const MAX_TOOL_OUTPUT_CHARS = 30_000

/** Pre-empt E2BIG: the whole command rides as one `sh -c` argv element, capped at MAX_ARG_STRLEN (131,072 bytes); commands are pure ASCII so chars == bytes. */
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

/** Short-circuit an exec-backed tool with an in-band refusal when its resolved rule is `deny`; otherwise run it. */
const guardExec = (
  name: string,
  run: Effect.Effect<BashResultValue, never, BashRunner>,
): Effect.Effect<BashResultValue, never, BashRunner> =>
  Effect.gen(function* () {
    const rules = yield* ApprovalRules
    if (resolveRule(rules, name) === "deny") {
      return { exitCode: -1, stdout: "", stderr: `Tool "${name}" is denied by session policy` }
    }
    return yield* run
  })

const commandTooLarge = (what: string): BashResultValue => ({
  exitCode: -1,
  stdout: "",
  stderr: `${what} too large for a single call (~64KB UTF-8 max) — split it into smaller pieces`,
})

/** POSIX single-quote escaping for path/pattern args; arbitrary CONTENT never rides this — it travels base64. */
const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`

/** Build `FLUE_X=<base64> ... bun -e '<script>'`; base64 values are shell-safe unquoted and scripts use double quotes only so the single-quoted wrapper holds. */
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
  needsApproval: needsApprovalFor("read_file"),
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
  needsApproval: needsApprovalFor("write_file"),
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
  needsApproval: needsApprovalFor("edit_file"),
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
  needsApproval: needsApprovalFor("glob"),
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
  needsApproval: needsApprovalFor("grep"),
})

/** Network read ceiling; the returned body is further capped for the prompt. */
const MAX_FETCH_BYTES = 100_000

/** How many redirect hops to follow before giving up (re-validated on each). */
const MAX_REDIRECT_HOPS = 5

/**
 * SSRF guard: reject hostnames pointing at the Worker's own network (localhost,
 * private/loopback/link-local/unique-local IP literals, `.internal`/`.local`),
 * re-applied to every redirect. Does NOT stop DNS rebinding — Workers exposes no
 * resolver to check a public hostname's resolved address before fetch.
 */
const isBlockedHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (host === "" || host === "localhost") return true
  if (host.endsWith(".internal") || host.endsWith(".local")) return true
  if (host.includes(":")) {
    if (host === "::1" || host === "::") return true
    if (/^fe[89ab]/.test(host)) return true
    if (/^f[cd]/.test(host)) return true
    return false
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4 !== null) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true
  }
  return false
}

const WebFetchResult = Schema.Struct({
  status: Schema.Number,
  contentType: Schema.String,
  body: Schema.String,
  truncated: Schema.Boolean,
})

type WebFetchResultValue = typeof WebFetchResult.Type

export const WebFetchTool = Tool.make("web_fetch", {
  description: `Fetch a public http(s) URL from the Worker (GET, up to ${MAX_REDIRECT_HOPS} redirects followed with the destination re-validated on each hop, 15s timeout) and return the response body as text. The body is read up to ${MAX_FETCH_BYTES} bytes and the returned text is capped at ${MAX_TOOL_OUTPUT_CHARS} characters (truncated=true when cut). A status of 0 means the fetch itself failed (invalid URL, unsupported scheme, blocked private/internal host, too many redirects, network error, or timeout) — the reason is in the body as "Error: ...".`,
  parameters: Schema.Struct({
    url: Schema.String.annotate({
      description: "Absolute http:// or https:// URL to fetch.",
    }),
  }),
  success: WebFetchResult,
  needsApproval: needsApprovalFor("web_fetch"),
})

/** Default passage count for search_knowledge; bounds tool output fed back into the prompt. */
const DEFAULT_KNOWLEDGE_RESULTS = 5

export const SearchKnowledgeTool = Tool.make("search_knowledge", {
  description:
    "Search the workspace knowledge base (indexed documents) for passages relevant to a query. Returns the top matching passages with their source filename and relevance score, or 'No relevant knowledge found.' Ground answers in these passages instead of guessing. Indexing is asynchronous — a just-uploaded document may not be searchable immediately.",
  parameters: Schema.Struct({
    query: Schema.String.annotate({ description: "Natural-language search query." }),
  }),
  success: Schema.String,
  dependencies: [KnowledgeSearch],
  needsApproval: needsApprovalFor("search_knowledge"),
})

const webFetchError = (message: string): WebFetchResultValue => ({
  status: 0,
  contentType: "",
  body: `Error: ${message}`,
  truncated: false,
})

/** Surface the first failure/defect in a cause as readable text for the model. */
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

/** Read the response body up to MAX_FETCH_BYTES; cancels the reader on early exit and streams decode so a byte cut can't split a multibyte char. */
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

/** Follow redirects manually, re-validating each hop's host and draining intermediate 3xx bodies; the AbortSignal wiring is load-bearing or the 15s timeout leaves the subrequest dangling. */
const followRedirects = (
  target: URL,
  hopsLeft: number,
): Effect.Effect<Response, Cause.UnknownError | Error> =>
  Effect.gen(function* () {
    const res = yield* Effect.tryPromise((signal) =>
      fetch(target.href, { redirect: "manual", signal }),
    )
    const location =
      res.status >= 300 && res.status < 400 ? res.headers.get("location") : null
    if (location === null) return res
    yield* Effect.promise(() => res.body?.cancel() ?? Promise.resolve())
    if (hopsLeft === 0) {
      return yield* Effect.fail(
        new Error(`too many redirects (>${MAX_REDIRECT_HOPS})`),
      )
    }
    const next = yield* Effect.try(() => new URL(location, target)).pipe(
      Effect.mapError(() => new Error(`invalid redirect target: ${location}`)),
    )
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      return yield* Effect.fail(
        new Error(`redirect to unsupported scheme: ${next.protocol}`),
      )
    }
    if (isBlockedHost(next.hostname)) {
      return yield* Effect.fail(
        new Error(
          `redirect to blocked host: ${next.hostname} (private/internal address)`,
        ),
      )
    }
    return yield* followRedirects(next, hopsLeft - 1)
  })

const runWebFetch = (url: string): Effect.Effect<WebFetchResultValue> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try(() => new URL(url))
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return yield* Effect.fail(
        new Error(`unsupported URL scheme: ${parsed.protocol} (only http/https)`),
      )
    }
    if (isBlockedHost(parsed.hostname)) {
      return yield* Effect.fail(
        new Error(`blocked host: ${parsed.hostname} (private/internal address)`),
      )
    }
    const response = yield* followRedirects(parsed, MAX_REDIRECT_HOPS)
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
    Effect.catchCause((cause) =>
      Effect.succeed(webFetchError(causeMessage(cause))),
    ),
  )

export const AgentToolkit = Toolkit.make(
  GetCurrentTimeTool,
  SpawnSubagentTool,
  ListSkillsTool,
  LoadSkillTool,
  BashTool,
  ReadFileTool,
  WriteFileTool,
  EditFileTool,
  GlobTool,
  GrepTool,
  WebFetchTool,
  SearchKnowledgeTool,
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
      Effect.tapErrorTag("SkillNotFoundError", (e) =>
        Effect.logWarning(`SpawnSubagent: skill not found: ${e.skill}`),
      ),
      Effect.tapErrorTag("RoleNotFoundError", (e) =>
        Effect.logWarning(`SpawnSubagent: role not found: ${e.role}`),
      ),
      Effect.tapErrorTag("AgentError", (e) =>
        Effect.logWarning(`SpawnSubagent: agent error: ${e.message}`),
      ),
      Effect.catchTags({
        SkillNotFoundError: (e) =>
          Effect.succeed(`Error: Skill not found: ${e.skill}`),
        RoleNotFoundError: (e) =>
          Effect.succeed(`Error: Role not found: ${e.role}`),
        AgentError: (e) => Effect.succeed(`Error: ${e.message}`),
      }),
    ),
  list_skills: () =>
    listSkills().pipe(
      Effect.map((skills) =>
        skills.map(
          (s) => new SkillSummary({ name: s.name, description: s.description }),
        ),
      ),
      Effect.tapErrorTag("AgentError", (e) =>
        Effect.logWarning(`list_skills: ${e.message}`),
      ),
      Effect.catchTag("AgentError", () => Effect.succeed([])),
    ),
  load_skill: (params) =>
    loadSkillBody(params.name).pipe(
      Effect.map(capText),
      Effect.tapErrorTag("SkillNotFoundError", (e) =>
        Effect.logWarning(`load_skill: not found: ${e.skill}`),
      ),
      Effect.catchTags({
        SkillNotFoundError: (e) =>
          Effect.succeed(`Error: Skill not found: ${e.skill}`),
        AgentError: (e) => Effect.succeed(`Error: ${e.message}`),
      }),
    ),
  Bash: (params) => guardExec("Bash", execCapped(params.command)),
  read_file: (params) =>
    guardExec("read_file", execCapped(`cat -- ${shellQuote(params.path)}`)),
  write_file: (params) => {
    const command = bunEval(
      {
        FLUE_PATH: Encoding.encodeBase64(params.path),
        FLUE_DATA: Encoding.encodeBase64(params.content),
      },
      WRITE_SCRIPT,
    )
    return guardExec(
      "write_file",
      command.length > MAX_COMMAND_CHARS
        ? Effect.succeed(commandTooLarge("content"))
        : execCapped(command),
    )
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
    return guardExec(
      "edit_file",
      command.length > MAX_COMMAND_CHARS
        ? Effect.succeed(commandTooLarge("old_string/new_string"))
        : execCapped(command),
    )
  },
  glob: (params) =>
    guardExec(
      "glob",
      execCapped(
        bunEval(
          {
            FLUE_PATTERN: Encoding.encodeBase64(params.pattern),
            FLUE_CWD: Encoding.encodeBase64(params.path ?? "."),
          },
          GLOB_SCRIPT,
        ),
      ),
    ),
  grep: (params) =>
    guardExec(
      "grep",
      execCapped(
        `grep -rEIn -e ${shellQuote(params.pattern)} -- ${shellQuote(params.path ?? ".")}`,
      ),
    ),
  web_fetch: (params) =>
    Effect.gen(function* () {
      const rules = yield* ApprovalRules
      return resolveRule(rules, "web_fetch") === "deny"
        ? webFetchError("denied by session policy")
        : yield* runWebFetch(params.url)
    }),
  search_knowledge: (params) =>
    Effect.gen(function* () {
      const rules = yield* ApprovalRules
      if (resolveRule(rules, "search_knowledge") === "deny") return "Error: denied by session policy"
      return yield* searchKnowledge(params.query, DEFAULT_KNOWLEDGE_RESULTS).pipe(
        Effect.map(capText),
        Effect.tapErrorTag("AgentError", (e) => Effect.logWarning(`search_knowledge: ${e.message}`)),
        Effect.catchTag("AgentError", (e) => Effect.succeed(`Error: ${e.message}`)),
      )
    }),
})
