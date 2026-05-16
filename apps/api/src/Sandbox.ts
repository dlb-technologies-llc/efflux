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
    main: import.meta.filename,
    instanceType: stack.stage === "prod" ? "standard-1" : "dev",
    observability: { logs: { enabled: true } },
  })),
) {}
