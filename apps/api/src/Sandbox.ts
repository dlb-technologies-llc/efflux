import * as Cloudflare from "alchemy/Cloudflare";
import { Stack } from "alchemy/Stack";
import { Effect as Effect } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { Stream as Stream } from "effect";
import { HttpServerResponse as HttpServerResponse } from "effect/unstable/http";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

export class Sandbox extends Cloudflare.Container<
  Sandbox,
  {
    exec: (command: string) => Effect.Effect<
      { exitCode: number; stdout: string; stderr: string },
      PlatformError
    >;
  }
>()(
  "Sandbox",
  Stack.useSync((stack) => ({
    main: import.meta.filename,
    instanceType: stack.stage === "prod" ? "standard-1" : "dev",
    observability: { logs: { enabled: true } },
  })),
) {}

export const SandboxLive = Sandbox.make(
  Effect.gen(function* () {
    const cp = yield* ChildProcessSpawner;
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
          Effect.scoped,
        ),
      fetch: Effect.succeed(
        HttpServerResponse.text("Sandbox container (use exec via RPC)"),
      ),
    });
  }),
);

export default SandboxLive;
