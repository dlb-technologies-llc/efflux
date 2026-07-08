#!/usr/bin/env bun
// Placeholder entry — replaced by the full Ink app in a later wave.
import { parseCliConfig } from "./cli.ts"

const config = parseCliConfig(process.argv.slice(2))
console.error(`parsed: ${JSON.stringify(config)} — interactive mode not yet implemented`)
process.exit(1)
