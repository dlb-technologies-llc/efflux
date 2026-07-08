import type { PromptOverrides } from "./client.ts"

/** Result of interpreting one slash-command line. Pure — no I/O here. */
export type CommandResult =
  | { readonly kind: "set-overrides"; readonly overrides: PromptOverrides; readonly note: string }
  | { readonly kind: "note"; readonly note: string }
  | { readonly kind: "reset" }
  | { readonly kind: "exit" }

const HELP =
  "commands: /model [name] · /skill [name] · /role [name] · /reset · /exit"

const showOrSet = (
  key: "model" | "skill" | "role",
  arg: string | undefined,
  overrides: PromptOverrides,
): CommandResult => {
  if (arg === undefined) {
    const current = overrides[key]
    return {
      kind: "note",
      note: `${key}: ${current ?? "(server default)"}`,
    }
  }
  return {
    kind: "set-overrides",
    overrides: { ...overrides, [key]: arg },
    note: `${key} set to ${arg}`,
  }
}

/**
 * Interpret a `/command` input line against the current overrides.
 * `/sessions` and `/journal` are not surfaced in the TUI yet — the server
 * endpoints exist (GET /agents, /agents/:name/:id/journal) and scripts/agent.ts
 * exercises them; wiring them into the TUI is future work.
 */
export const handleCommand = (
  input: string,
  overrides: PromptOverrides,
): CommandResult => {
  const [command, ...rest] = input.trim().split(/\s+/)
  const arg = rest[0]
  switch (command) {
    case "/model":
      return showOrSet("model", arg, overrides)
    case "/skill":
      return showOrSet("skill", arg, overrides)
    case "/role":
      return showOrSet("role", arg, overrides)
    case "/reset":
      return { kind: "reset" }
    case "/exit":
    case "/quit":
      return { kind: "exit" }
    default:
      return { kind: "note", note: `unknown command ${command ?? ""} — ${HELP}` }
  }
}
