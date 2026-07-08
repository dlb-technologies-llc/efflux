import { Container } from "@cloudflare/containers"

/**
 * Container-backed Durable Object for the `Bash` tool.
 *
 * The container image (`apps/api/container/Dockerfile`) runs an HTTP server
 * on port 8080 exposing `POST /exec {command}` → `{exitCode, stdout,
 * stderr}`. The Container base class routes `stub.fetch(...)` from the
 * `Agent` DO to that port, boots the container on first request, and shuts
 * it down after 10 minutes idle.
 */
export class Sandbox extends Container<Env> {
  defaultPort = 8080
  sleepAfter = "10m"
}
