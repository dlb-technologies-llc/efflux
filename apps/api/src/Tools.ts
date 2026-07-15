/**
 * Tools exposed to the parent prompt loop: clock, subagent spawn, Bash, and the
 * file/search ops (all on the same exec seam as Bash) plus Worker-side web_fetch.
 */
import {
  CronExpression,
  DEFAULT_TOOL_RULES,
  JournalTodoWrite,
  resolveRule,
  type RulesMap,
  SafeName,
  SkillSummary,
  SubagentTaskRequest,
} from "@efflux/shared"
import { Context, Effect, Encoding, Schema } from "effect"
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai"
import { KnowledgeSearch, searchKnowledge } from "./Knowledge.ts"
import { SecretsStore } from "./Secrets.ts"
import { listSkills, loadSkillBody, SkillsBucket } from "./Skills.ts"
import { runSubagent } from "./Subagent.ts"
import { formatTodos, TodoStore } from "./Todo.ts"
import { MAX_TOOL_OUTPUT_CHARS, capForPrompt } from "./Truncate.ts"
import {
  MAX_FETCH_BYTES,
  MAX_REDIRECT_HOPS,
  runWebFetch,
  WebFetchResult,
  webFetchError,
} from "./WebFetch.ts"

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

/** Per-request handle to the DO's createScheduledJob(input) RPC, provided per-request from the resolved Agent stub (mirrors BashRunner). */
export class ScheduledJobs extends Context.Service<
  ScheduledJobs,
  {
    readonly create: (input: {
      readonly description: string
      readonly entrypointCommand: string
      readonly schedule: string
    }) => Effect.Effect<
      { readonly id: string; readonly nextRunAt: number } | { readonly error: string }
    >
  }
>()("api/ScheduledJobs") {}

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
  needsApproval: needsApprovalFor("list_skills"),
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
  needsApproval: needsApprovalFor("load_skill"),
})

const BashParameters = Schema.Struct({
  command: Schema.String.annotate({
    description:
      "Shell command to execute. Runs via `sh -c <command>` inside the sandboxed Linux container.",
  }),
})

export const BashTool = Tool.make("Bash", {
  description:
    "Execute a shell command in the sandboxed Linux container bound to this agent session. Returns the exit code, stdout, and stderr. The working directory is /workspace — a writable but EPHEMERAL scratch space, wiped when the sandbox idles out (~1 minute of inactivity) or redeploys. Use this for devops-style operations the dedicated file tools do not cover.",
  parameters: BashParameters,
  success: BashResult,
  dependencies: [BashRunner],
  needsApproval: needsApprovalFor("Bash"),
})

/** Pre-empt E2BIG: the whole command rides as one `sh -c` argv element, capped at MAX_ARG_STRLEN (131,072 bytes); commands are pure ASCII so chars == bytes. */
const MAX_COMMAND_CHARS = 90_000

const EPHEMERAL_NOTE =
  "Paths resolve relative to /workspace, a writable but EPHEMERAL scratch space — contents are wiped when the sandbox idles out (~1 minute of inactivity) or redeploys."

const capExecResult = (result: BashResultValue): BashResultValue => ({
  exitCode: result.exitCode,
  stdout: capForPrompt(result.stdout),
  stderr: capForPrompt(result.stderr),
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

/** Build `EFFLUX_X=<base64> ... bun -e '<script>'`; base64 values are shell-safe unquoted and scripts use double quotes only so the single-quoted wrapper holds. */
const bunEval = (env: Record<string, string>, script: string): string => {
  const assignments = Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ")
  return `${assignments} bun -e '${script}'`
}

const WRITE_SCRIPT = `
const path = Buffer.from(process.env.EFFLUX_PATH ?? "", "base64").toString("utf8");
const data = Buffer.from(process.env.EFFLUX_DATA ?? "", "base64");
const n = await Bun.write(path, data);
console.log("Wrote " + n + " bytes to " + path);
`.trim()

const EDIT_SCRIPT = `
const path = Buffer.from(process.env.EFFLUX_PATH ?? "", "base64").toString("utf8");
const oldStr = Buffer.from(process.env.EFFLUX_OLD ?? "", "base64").toString("utf8");
const newStr = Buffer.from(process.env.EFFLUX_NEW ?? "", "base64").toString("utf8");
const replaceAll = process.env.EFFLUX_ALL === "1";
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
const pattern = Buffer.from(process.env.EFFLUX_PATTERN ?? "", "base64").toString("utf8");
const cwd = Buffer.from(process.env.EFFLUX_CWD ?? "", "base64").toString("utf8") || ".";
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

export const TodoWriteTool = Tool.make("todo_write", {
  description:
    "Replace the session task list with the given items (each: content + status pending|in_progress|completed). Use this to plan and track multi-step work; the list persists across turns and is shown to you at the start of every turn. Pass the FULL list each time — it overwrites the previous one.",
  parameters: Schema.Struct({ items: JournalTodoWrite.fields.items }),
  success: Schema.String,
  dependencies: [TodoStore],
  needsApproval: needsApprovalFor("todo_write"),
})

export const TodoReadTool = Tool.make("todo_read", {
  description:
    "Return the current session task list as a checklist. The list is also injected at the start of each turn, so call this only to re-check it mid-turn.",
  success: Schema.String,
  dependencies: [TodoStore],
  needsApproval: needsApprovalFor("todo_read"),
})

export const HasSecretTool = Tool.make("has_secret", {
  description:
    "Check whether a named secret is already available in this session, without revealing its value. Call this BEFORE request_secret to avoid re-prompting for a secret the user has already provided.",
  parameters: Schema.Struct({
    name: Schema.String.annotate({
      description: "Secret name to check, e.g. STRIPE_API_KEY.",
    }),
  }),
  success: Schema.Boolean,
  dependencies: [SecretsStore],
})

export const RequestSecretTool = Tool.make("request_secret", {
  description:
    "Ask the user to provide a secret value (e.g. an API key) needed to complete the task. Always requires human approval before the secret is collected — check has_secret first so you don't re-request a secret that is already available.",
  parameters: Schema.Struct({
    name: SafeName.annotate({
      description:
        "Secret name to request, e.g. STRIPE_API_KEY — alphanumeric/hyphen/underscore only, 1-64 chars (must be a valid shell identifier and pass the storage endpoint's name validation).",
    }),
    description: Schema.String.annotate({
      description: "Human-readable explanation of why this secret is needed.",
    }),
  }),
  success: Schema.String,
  dependencies: [SecretsStore],
  needsApproval: needsApprovalFor("request_secret"),
})

export const CreateScheduledJobTool = Tool.make("create_scheduled_job", {
  description:
    "Schedule a recurring job that runs a shell command in this session's sandbox on a UTC cron schedule. Always requires human approval before the job is created.",
  parameters: Schema.Struct({
    description: Schema.String.annotate({
      description: "Human-readable description of what the job does.",
    }),
    entrypointCommand: Schema.String.annotate({
      description: "Shell command to run when the job fires.",
    }),
    schedule: CronExpression.annotate({
      description:
        "UTC cron expression (minute hour day-of-month month day-of-week) or a macro (@hourly/@daily/@weekly/@monthly/@yearly). Supports *, lists (1,15), ranges (9-17), and steps (*/10). Examples: '*/10 * * * *' every 10 min; '0 * * * *' hourly; '30 6 * * *' daily 06:30; '0 9 * * 1-5' 09:00 on weekdays. No timezones or names.",
    }),
  }),
  success: Schema.String,
  dependencies: [ScheduledJobs],
  needsApproval: needsApprovalFor("create_scheduled_job"),
})

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
  TodoWriteTool,
  TodoReadTool,
  HasSecretTool,
  RequestSecretTool,
  CreateScheduledJobTool,
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
    Effect.gen(function* () {
      const rules = yield* ApprovalRules
      if (resolveRule(rules, "list_skills") === "deny") return []
      return yield* listSkills().pipe(
        Effect.map((skills) =>
          skills.map(
            (s) => new SkillSummary({ name: s.name, description: s.description }),
          ),
        ),
        Effect.tapErrorTag("AgentError", (e) =>
          Effect.logWarning(`list_skills: ${e.message}`),
        ),
        Effect.catchTag("AgentError", () => Effect.succeed([])),
      )
    }),
  load_skill: (params) =>
    Effect.gen(function* () {
      const rules = yield* ApprovalRules
      if (resolveRule(rules, "load_skill") === "deny") return "Error: denied by session policy"
      return yield* loadSkillBody(params.name).pipe(
        Effect.map(capForPrompt),
        Effect.tapErrorTag("SkillNotFoundError", (e) =>
          Effect.logWarning(`load_skill: not found: ${e.skill}`),
        ),
        Effect.catchTags({
          SkillNotFoundError: (e) =>
            Effect.succeed(`Error: Skill not found: ${e.skill}`),
          AgentError: (e) => Effect.succeed(`Error: ${e.message}`),
        }),
      )
    }),
  Bash: (params) => guardExec("Bash", execCapped(params.command)),
  read_file: (params) =>
    guardExec("read_file", execCapped(`cat -- ${shellQuote(params.path)}`)),
  write_file: (params) => {
    const command = bunEval(
      {
        EFFLUX_PATH: Encoding.encodeBase64(params.path),
        EFFLUX_DATA: Encoding.encodeBase64(params.content),
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
        EFFLUX_PATH: Encoding.encodeBase64(params.path),
        EFFLUX_OLD: Encoding.encodeBase64(params.old_string),
        EFFLUX_NEW: Encoding.encodeBase64(params.new_string),
        EFFLUX_ALL: params.replace_all === true ? "1" : "0",
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
            EFFLUX_PATTERN: Encoding.encodeBase64(params.pattern),
            EFFLUX_CWD: Encoding.encodeBase64(params.path ?? "."),
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
        Effect.map(capForPrompt),
        Effect.tapErrorTag("AgentError", (e) => Effect.logWarning(`search_knowledge: ${e.message}`)),
        Effect.catchTag("AgentError", (e) => Effect.succeed(`Error: ${e.message}`)),
      )
    }),
  todo_write: (params) =>
    Effect.gen(function* () {
      const rules = yield* ApprovalRules
      if (resolveRule(rules, "todo_write") === "deny") return "Error: denied by session policy"
      const store = yield* TodoStore
      yield* store.write(params.items)
      return `Updated task list:\n${formatTodos(params.items)}`
    }),
  todo_read: () =>
    Effect.gen(function* () {
      const rules = yield* ApprovalRules
      if (resolveRule(rules, "todo_read") === "deny") return "Error: denied by session policy"
      const store = yield* TodoStore
      return formatTodos(yield* store.read)
    }),
  has_secret: (params) => SecretsStore.use((store) => store.has(params.name)),
  /** Runs after human approval resumes the parked turn — but approval only means "resume the turn," not "the secret was actually stored" (the generic /approve endpoint can resolve ANY parked call with approved:true, including one where the FE's submit-secret-then-approve two-step never ran, e.g. a direct API caller). Actually checks has() and reports the true outcome either way; never reads or returns the secret's raw value. */
  request_secret: (params) =>
    SecretsStore.use((store) => store.has(params.name)).pipe(
      Effect.map((exists) =>
        exists
          ? `${params.name} is now available`
          : `${params.name} was NOT provided — the request was skipped, denied, or resolved without the secret ever being stored. Ask the user to provide it again if it's still needed.`
      ),
    ),
  create_scheduled_job: (params) =>
    ScheduledJobs.use((jobs) =>
      jobs.create({
        description: params.description,
        entrypointCommand: params.entrypointCommand,
        schedule: params.schedule,
      }),
    ).pipe(
      Effect.map((result) =>
        "error" in result
          ? `Could not schedule '${params.schedule}': ${result.error}. Provide a cron expression that has a future occurrence.`
          : `Scheduled '${params.schedule}' — next run ${new Date(result.nextRunAt).toISOString()} UTC`,
      ),
    ),
})
