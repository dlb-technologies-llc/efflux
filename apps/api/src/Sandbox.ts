import * as Cloudflare from "alchemy/Cloudflare"
import { Stack } from "alchemy/Stack"
import type { Effect } from "effect"

export class Sandbox extends Cloudflare.Container<
  Sandbox,
  {
    readonly exec: (
      command: string,
    ) => Effect.Effect<{
      readonly exitCode: number
      readonly stdout: string
      readonly stderr: string
    }>
  }
>()(
  "Sandbox",
  Stack.useSync((stack) => ({
    // The alchemy bundler imports `default` from `main` as the container's
    // entrypoint (see ContainerApplication.ts virtual entry plugin). Since
    // the class and runtime are split (per the Container Layer pattern),
    // `main` must point at the runtime file — the class file has no
    // default export.
    main: import.meta.filename.replace(/Sandbox\.ts$/, "Sandbox.runtime.ts"),
    instanceType: stack.stage === "prod" ? "standard-1" : "dev",
    observability: { logs: { enabled: true } },
  })),
) {}
