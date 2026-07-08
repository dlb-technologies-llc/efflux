import { Container } from "@cloudflare/containers"

/**
 * Container-backed Durable Object for the `Bash` tool.
 *
 * The container image (`apps/api/container/Dockerfile`) runs an HTTP server
 * on port 8080 exposing `POST /exec {command}` → `{exitCode, stdout,
 * stderr}`, plus the durable-workspace endpoints `GET /status`
 * (`{hydrated}`), `POST /restore` (gzipped tar → /workspace; empty body
 * marks hydrated), and `GET /snapshot` (gzipped tar of /workspace; 409
 * until hydrated). The Container base class routes `stub.fetch(...)` from
 * the `Agent` DO to that port, boots the container on first request, and
 * shuts it down after 10 minutes idle.
 *
 * The container never sees R2: snapshot/restore bytes move Agent DO ↔
 * container over this proxy, and Agent DO ↔ R2 via the `SESSIONS` binding
 * (`workspaces/<name>.tar.gz`).
 */
export class Sandbox extends Container<Env> {
  defaultPort = 8080
  sleepAfter = "10m"

  // Egress posture (deliberate — not the silent default).
  //
  // Verified against @cloudflare/containers@0.3.7:
  //   - The base class defaults `enableInternet = true`
  //     (dist/lib/container.js:325), so a subclass that sets neither field
  //     inherits OPEN internet egress — the container runs model-generated
  //     shell (curl/wget), so that default is worth making explicit.
  //   - `deniedHosts?: string[]` (dist/lib/container.d.ts:69) is enforced in
  //     `ContainerProxy.fetch` via `matchesHostList` → `simpleGlobMatch`
  //     (dist/lib/container.js:104,121-123,202-205): entries are matched as
  //     GLOB PATTERNS against the request's hostname string (`*` = any run of
  //     characters), and a match blocks unconditionally even while
  //     `enableInternet` is true. Declaring the field activates outbound
  //     interception (`effectiveDeniedHosts !== undefined` →
  //     `usingInterception = true`, dist/lib/container.js:366-368).
  //
  // Decision: keep internet ENABLED — a coding sandbox legitimately needs
  // package installs (npm/pip/apt) reaching arbitrary registries/mirrors —
  // but deny the cloud instance-metadata address and the whole link-local
  // block, which have no legitimate outbound use and are the classic
  // SSRF / credential-theft target.
  //
  // Limitation: matching is string/glob only — there is NO CIDR support, so
  // RFC-1918 private ranges cannot be denied as ranges. Octet-aligned blocks
  // can be approximated with a `*` glob (169.254.* covers 169.254.0.0/16
  // below), but non-octet-aligned CIDR (e.g. 172.16.0.0/12) is inexpressible;
  // `enableInternet` is the only true range-wide lever. Also, `interceptHttps`
  // defaults to false (dist/lib/container.js:329), so the deny-list is
  // enforced on plaintext HTTP outbound — which is exactly the transport the
  // link-local metadata endpoint speaks.
  enableInternet = true
  deniedHosts = ["169.254.169.254", "169.254.*"]
}
