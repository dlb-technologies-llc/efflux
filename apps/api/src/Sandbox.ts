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
}
