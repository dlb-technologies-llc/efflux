# Security

Efflux runs model-authored shell commands inside a Cloudflare Container. **Executing
untrusted code is the product**, not an incidental capability — so the deployment
boundary around it matters more than it would for a typical web app. Read this before
you put an instance on the public internet.

> [!NOTE]
> This repository currently ships **local-only**: the `deploy`/`predeploy` scripts are
> removed and the upstream account resources were decommissioned (see *Deploy (disabled
> — local-only)* in the README). Nothing here is deployed. Everything below applies the
> moment you re-enable deploy and put an instance on a reachable hostname — read it
> first, not after.

## The browser token is not an authentication boundary

Every endpoint requires an `Authorization: Bearer $API_TOKEN` header, compared against
the `API_TOKEN` secret in constant time (`apps/api/src/AuthMiddleware.ts`). Requests
without it get a 401. That part is real.

What is **not** real is the web console's half of it. `VITE_API_TOKEN` is inlined into
the public JavaScript bundle at build time (`apps/web/src/runtime.ts`), because the
console is a static asset served by the same Worker and has nowhere else to keep a
credential. Anyone who loads the page can read the token out of the bundle.

So on a publicly reachable deployment, the bearer token gates non-browser abuse and
nothing else. Treat it as a demo-grade speed bump, not access control.

### What an attacker with the token gets

- Arbitrary shell execution in your `Sandbox` container, via the `Bash` tool.
- Your OpenRouter spend, via unlimited model calls on your key.
- Whatever is in a session's encrypted secrets, to the extent a session's own tools
  can reach it.
- Billable container time. For calibration, ordinary single-developer testing against
  a deployed instance produced ~672 cumulative instance-hours in one billing period
  (see `ISSUES.md`); an attacker running a miner is a different number entirely.

### Deploy it behind something

If the instance is not meant for the public, put an identity boundary in front of the
Worker — [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
is the native fit and takes minutes. Use a long random `API_TOKEN` regardless, keep
`workers.dev` routes off for anything real, and rotate the token if a bundle built with
it was ever served publicly.

Do not treat "the URL is unlisted" as protection. `workers.dev` hostnames are
enumerable.

## What the code does defend

These are implemented and tested, not aspirational:

- **Constant-time bearer comparison** — `AuthMiddleware.ts`; token comparison does not
  short-circuit, so response timing does not leak the token.
- **Encrypted session secrets** — `SecretsCrypto.ts`; AES-GCM with a SHA-256-derived
  32-byte key and a fresh random 12-byte IV per encryption. The GCM tag means tampered
  ciphertext fails closed rather than decrypting to garbage.
- **Ask-by-default tool policy** — `packages/shared/src/Config.ts`; `Bash`,
  `request_secret`, `create_scheduled_job`, `memory_write`, and `memory_delete` all
  require explicit approval unless a session opts out. Sessions can set a tool to
  `allow`; that is a deliberate choice with consequences.
- **SSRF guard on MCP server URLs too** — `apps/api/src/Mcp.ts` runs the same
  `isBlockedHost` check on configured server URLs and on redirect targets, so a
  session-supplied MCP endpoint cannot be pointed at internal addresses.
- **`web_search` takes no URL.** It POSTs a query to one fixed upstream endpoint
  (`apps/api/src/WebSearch.ts`), so it is not an SSRF surface; `web_fetch` is the tool
  that accepts a caller-supplied URL, and that one is guarded.
- **SSRF guard on `web_fetch`** — `Ssrf.ts`; blocks localhost, loopback, private,
  link-local and unique-local ranges, IPv4-mapped/compat IPv6 forms, bare
  integer/hex IP literals, and `.internal`/`.local` suffixes.

## Known limitations

Documented rather than hidden, so you can judge them yourself:

- **Gating `Bash` does not confine the container filesystem.** `read_file`,
  `write_file`, `edit_file`, `glob`, and `grep` are exec-backed — they run shell
  commands in the same sandbox — but they are absent from `DEFAULT_TOOL_RULES`, and
  `resolveRule` defaults absent tools to `allow`. A session that sets `Bash: "deny"`
  still has unprompted read/write access to the container's workspace. Deny them
  explicitly if that is not what you want. (Their arguments are shell-quoted or
  base64-passed, so this is a policy gap, not a command-injection one.)
- **The SSRF guard does not stop DNS rebinding**, nor dotted octal/hex octet
  obfuscation. It is a hostname filter, not a network policy. See the module doc in
  `apps/api/src/Ssrf.ts`.
- **`/approve` resolves any parked tool call generically.** A caller holding the bearer
  token can approve a parked call with `approved: true` even if the paired step (e.g.
  submitting a secret) never ran. The secret tool checks the real outcome and reports it
  honestly rather than assuming success (`apps/api/src/Tools.ts`), but the approval
  endpoint itself does not bind an approval to the specific call that requested it.
- **Container isolation is Cloudflare's**, not ours. The sandbox runs as the non-root
  `bun` user in `/workspace`, but the security properties of the boundary are whatever
  Cloudflare Containers provides.
- **The container base image is tagged, not digest-pinned** (`oven/bun:1.3-slim`), so
  builds are not byte-reproducible. See the note at the top of
  `apps/api/container/Dockerfile`.

## Reporting a vulnerability

Please report suspected vulnerabilities through GitHub's private reporting flow
(**Security → Report a vulnerability** on the repository) rather than opening a public
issue. Include reproduction steps and the affected commit. This is a reference
implementation maintained on a best-effort basis — there is no formal SLA, but real
reports will be looked at.
