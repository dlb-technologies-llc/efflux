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

  // Egress posture — a DELIBERATE decision, not the silent default. Internet is
  // ENABLED: a coding sandbox legitimately needs package installs (npm/pip/apt)
  // reaching arbitrary registries. The base class already defaults this to
  // `true` (@cloudflare/containers@0.3.7, dist/lib/container.js:325), but we set
  // it explicitly so the choice is visible and reviewable.
  enableInternet = true

  // A denylist (e.g. `deniedHosts` for the metadata address / link-local range)
  // is DEFERRED, not forgotten: setting `deniedHosts` flips the base into its
  // outbound-INTERCEPTION mode (`usingInterception = true`,
  // dist/lib/container.js:366-368), which routes egress through a
  // `ctx.exports.ContainerProxy` WorkerEntrypoint. Live testing showed that
  // path destabilizes container start/exec for this Worker (the Bash tool
  // 500s), so enabling it needs its own focused integration + verification.
  // Tracked as a follow-up; `deniedHosts` matching is also glob-only (no CIDR),
  // so it could never express RFC-1918 ranges anyway.
}
