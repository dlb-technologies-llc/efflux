import { Container } from "@cloudflare/containers"

/**
 * Container-backed Durable Object for the `Bash` tool: routes `stub.fetch(...)`
 * from the `Agent` DO to the container's :8080 exec/status/restore/snapshot
 * endpoints, boots on first request, idles out after 10m. Never sees R2 —
 * snapshot/restore bytes move Agent DO ↔ container; Agent DO ↔ R2 is the SESSIONS binding.
 */
export class Sandbox extends Container<Env> {
  defaultPort = 8080
  sleepAfter = "10m"

  /** Internet ENABLED (explicit, not the silent default): a coding sandbox needs package installs reaching arbitrary registries. */
  enableInternet = true

  /** Explicitly destroy the running container (SIGKILL now, not the 10m `sleepAfter` idle-out). Best-effort: a not-running container is a no-op — errors are logged, never thrown, so `close()`/reap never rejects on a dead sandbox. */
  async destroyContainer(): Promise<void> {
    try {
      await this.destroy()
    } catch (error) {
      console.error("container destroy failed (already stopped?)", error)
    }
  }
}
