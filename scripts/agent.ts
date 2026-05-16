#!/usr/bin/env bun
// CLI wrapper around the deployed Worker's agent endpoint.
// Usage: bun run agent <name> <id> --message "hi" [--url URL] [--model M] [--skill S] [--role R]
export {}

const USAGE =
  'Usage: bun run agent <name> <id> --message "text" [--url URL] [--model M] [--skill S] [--role R]';

const argv = process.argv.slice(2);
const positional: string[] = [];
const flags: Record<string, string> = {};

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === undefined) continue;
  if (arg.startsWith("--")) {
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      console.error(`Missing value for --${key}`);
      console.error(USAGE);
      process.exit(1);
    }
    flags[key] = value;
    i++;
  } else {
    positional.push(arg);
  }
}

const agentName = positional[0];
const id = positional[1];
const message = flags["message"];

if (agentName === undefined || id === undefined || message === undefined) {
  console.error(USAGE);
  process.exit(1);
}

const baseUrl = flags["url"] ?? process.env["BASE_URL"];
if (baseUrl === undefined || baseUrl === "") {
  console.error("BASE_URL or --url required");
  process.exit(1);
}

const body: Record<string, string> = { message };
if (flags["model"] !== undefined) body["model"] = flags["model"];
if (flags["skill"] !== undefined) body["skill"] = flags["skill"];
if (flags["role"] !== undefined) body["role"] = flags["role"];

const url = `${baseUrl.replace(/\/$/, "")}/agents/${encodeURIComponent(agentName)}/${encodeURIComponent(id)}`;

const res = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const text = await res.text();

if (!res.ok) {
  console.error(`HTTP ${res.status} ${res.statusText}`);
  console.error(text);
  process.exit(1);
}

try {
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "text" in parsed &&
    typeof parsed.text === "string"
  ) {
    console.log(parsed.text);
  } else {
    console.log(text);
  }
} catch {
  console.log(text);
}
