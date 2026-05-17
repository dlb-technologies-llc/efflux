import { Effect, Stream } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { Sandbox } from "./Sandbox.ts"

export const SandboxLive = Sandbox.make(
  Effect.gen(function* () {
    const cp = yield* ChildProcessSpawner
    return Sandbox.of({
      exec: (command) =>
        cp.spawn(ChildProcess.make(command, { shell: true })).pipe(
          Effect.flatMap((handle) =>
            Effect.all(
              [
                handle.exitCode,
                handle.stdout.pipe(Stream.decodeText, Stream.mkString),
                handle.stderr.pipe(Stream.decodeText, Stream.mkString),
              ],
              { concurrency: "unbounded" },
            ),
          ),
          Effect.map(([exitCode, stdout, stderr]) => ({
            exitCode: Number(exitCode),
            stdout,
            stderr,
          })),
          // PlatformError must not cross the DO RPC fence — catch here so
          // the runtime Effect's failure channel is `never`. Spawn errors
          // surface to the caller as `exitCode: -1, stderr: <message>`.
          Effect.catch((error) =>
            Effect.succeed({
              exitCode: -1,
              stdout: "",
              stderr:
                error instanceof Error
                  ? error.message
                  : `Sandbox.exec failed: ${String(error)}`,
            }),
          ),
          Effect.scoped,
        ),
      fetch: Effect.succeed(
        HttpServerResponse.text("Sandbox container (use exec via RPC)"),
      ),
    })
  }),
)

export default SandboxLive
