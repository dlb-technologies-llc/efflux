export const USAGE =
  'Usage: bun run tui <name> <id> [--url URL] [--message TEXT] [--model M] [--skill S] [--role R]\n' +
  "  --url or BASE_URL env required. --message runs one-shot (non-interactive) mode."

export interface CliConfig {
  readonly baseUrl: string
  readonly name: string
  readonly id: string
  readonly message?: string
  readonly model?: string
  readonly skill?: string
  readonly role?: string
}

/** Parse argv (post `process.argv.slice(2)`); prints usage and exits 1 on invalid input. */
export const parseCliConfig = (argv: ReadonlyArray<string>): CliConfig => {
  const positional: Array<string> = []
  const flags: Record<string, string> = {}

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined) continue
    if (arg.startsWith("--")) {
      const key = arg.slice(2)
      const value = argv[i + 1]
      if (value === undefined || value.startsWith("--")) {
        console.error(`Missing value for --${key}`)
        console.error(USAGE)
        process.exit(1)
      }
      flags[key] = value
      i++
    } else {
      positional.push(arg)
    }
  }

  const name = positional[0]
  const id = positional[1]
  if (name === undefined || id === undefined) {
    console.error(USAGE)
    process.exit(1)
  }

  const baseUrl = flags["url"] ?? process.env["BASE_URL"]
  if (baseUrl === undefined || baseUrl === "") {
    console.error("BASE_URL or --url required")
    console.error(USAGE)
    process.exit(1)
  }

  return {
    baseUrl,
    name,
    id,
    ...(flags["message"] !== undefined ? { message: flags["message"] } : {}),
    ...(flags["model"] !== undefined ? { model: flags["model"] } : {}),
    ...(flags["skill"] !== undefined ? { skill: flags["skill"] } : {}),
    ...(flags["role"] !== undefined ? { role: flags["role"] } : {}),
  }
}
