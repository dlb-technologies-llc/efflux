import { Container } from "@cloudflare/containers"

/**
 * Container-backed Durable Object for one-shot scheduled/generated runs: same
 * exec/status/restore/snapshot protocol as `Sandbox`, but sleeps fast instead
 * of idling like the interactive coding sandbox.
 */
export class Runner extends Container<Env> {
  defaultPort = 8080

  /** One-shot scheduled runs are destroyed right after each run — this only bounds a leftover instance that failed to be explicitly destroyed. */
  sleepAfter = "1m"

  /** v1 scope decision: credentials are interpolated into the one-shot exec command rather than relayed through a zero-trust proxy; see the `feature-generating` plan's "Design decisions" #6 for the accepted tradeoff. */
  enableInternet = true

  /** Explicitly destroy the running container. Best-effort: a not-running container is a no-op — errors are logged, never thrown. */
  async destroyContainer(): Promise<void> {
    try {
      await this.destroy()
    } catch (error) {
      console.error("runner destroy failed (already stopped?)", error)
    }
  }
}
