import { Container } from "@cloudflare/containers"

/**
 * Container-backed Durable Object for the `Bash` tool: routes `stub.fetch(...)`
 * from the `Agent` DO to the container's :8080 exec/status/restore/snapshot
 * endpoints, boots on first request, idles out after 1m. Never sees R2 —
 * snapshot/restore bytes move Agent DO ↔ container; Agent DO ↔ R2 is the SESSIONS binding.
 */
export class Sandbox extends Container<Env> {
  defaultPort = 8080

  /** Short on purpose: container memory bills for the full time it's provisioned, not actual use, so a long idle window bills for time nobody's using — 1m still comfortably covers back-to-back tool calls within one active turn (seconds apart) without cold-starting between them, while cutting idle-billed time ~10x versus the original 10m. */
  sleepAfter = "1m"

  /** Internet ENABLED (explicit, not the silent default): a coding sandbox needs package installs reaching arbitrary registries. */
  enableInternet = true

  /** Explicitly destroy the running container (SIGKILL now, not the 1m `sleepAfter` idle-out). Best-effort: a not-running container is a no-op — errors are logged, never thrown, so `close()`/reap never rejects on a dead sandbox. */
  async destroyContainer(): Promise<void> {
    try {
      await this.destroy()
    } catch (error) {
      console.error("container destroy failed (already stopped?)", error)
    }
  }
}
