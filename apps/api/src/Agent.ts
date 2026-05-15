import {
  Message,
  type PromptResponse,
  StreamPartDone,
  StreamPartTextDelta,
  StreamPartToolCall,
  StreamPartToolResult,
} from "@effect-flue/shared";
import {
  OpenRouterClient,
  OpenRouterLanguageModel,
} from "@effect/ai-openrouter";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Filter from "effect/Filter";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";
import { OpenRouterKey } from "./Secrets.ts";
import { Sandbox } from "./Sandbox.ts";
import { Skills } from "./Skills.ts";

const DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";

const HistorySchema = Schema.Array(Message);

export default class Agent extends Cloudflare.DurableObjectNamespace<Agent>()(
  "Agents",
  Effect.gen(function* () {
    const skills = yield* Cloudflare.R2Bucket.bind(Skills);
    const apiKey = yield* Cloudflare.Secret.bind(OpenRouterKey);
    const sandbox = yield* Cloudflare.Container.bind(Sandbox);

    // Nested Effect.gen is the DurableObjectNamespace contract: outer
    // = per-class init, inner = per-instance methods.
    // @effect-diagnostics-next-line returnEffectInGen:off
    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      const container = yield* Cloudflare.start(sandbox);

      const clientLayer = OpenRouterClient.layer({
        apiKey: Redacted.make(yield* apiKey.pipe(Effect.orDie)),
      }).pipe(Layer.provide(FetchHttpClient.layer));

      const Bash = Tool.make("bash", {
        description: "Execute a bash command in a sandboxed Linux container.",
        parameters: Schema.Struct({
          command: Schema.String.annotate({
            description:
              "The shell command to run, e.g. `grep -ri auth /workspace/kb`.",
          }),
        }),
        success: Schema.Struct({
          exitCode: Schema.Number,
          stdout: Schema.String,
          stderr: Schema.String,
        }),
      });

      const toolkit = Toolkit.make(Bash);
      const toolkitLayer = toolkit.toLayer(
        Effect.succeed(
          toolkit.of({
            bash: ({ command }: { command: string }) =>
              container.exec(command).pipe(
                Effect.map((r) => ({ ...r, exitCode: Number(r.exitCode) })),
                Effect.orDie,
              ),
          }),
        ),
      );

      const stripFrontmatter = (s: string) =>
        s.replace(/^---\n[\s\S]*?\n---\n/, "").trim();

      const loadSkill = (name: string) =>
        skills.get(`skills/${name}.md`).pipe(
          Effect.flatMap((obj) =>
            obj === null ? Effect.succeed("") : obj.text(),
          ),
          Effect.map(stripFrontmatter),
          Effect.catchCause(() => Effect.succeed("")),
        );

      const decodeHistory = Schema.decodeUnknownEffect(HistorySchema);
      const encodeHistory = Schema.encodeEffect(HistorySchema);

      const loadHistory = state.storage.get<unknown>("history").pipe(
        Effect.flatMap((raw) =>
          raw === undefined
            ? Effect.succeed<ReadonlyArray<Message>>([])
            : decodeHistory(raw),
        ),
        Effect.orDie,
      );

      const saveHistory = (h: ReadonlyArray<Message>) =>
        encodeHistory(h).pipe(
          Effect.flatMap((encoded) => state.storage.put("history", encoded)),
          Effect.orDie,
        );

      const buildMessages = (skillBody: string, msgs: ReadonlyArray<Message>) =>
        [
          ...(skillBody
            ? [Prompt.makeMessage("system", { content: skillBody })]
            : []),
          ...msgs.map((m) =>
            Prompt.makeMessage(m.role, {
              content: [Prompt.makePart("text", { text: m.content })],
            }),
          ),
        ];

      return {
        prompt: (input: {
          message: string;
          model?: string;
          skill?: string;
        }) =>
          Effect.gen(function* () {
            const skillBody = yield* loadSkill(input.skill ?? "support");
            const history = yield* loadHistory;
            const next: ReadonlyArray<Message> = [
              ...history,
              new Message({ role: "user", content: input.message }),
            ];

            const response = yield* LanguageModel.generateText({
              prompt: Prompt.fromMessages(buildMessages(skillBody, next)),
              toolkit,
            }).pipe(
              Effect.provide(
                OpenRouterLanguageModel.model(input.model ?? DEFAULT_MODEL),
              ),
            );

            const updated: ReadonlyArray<Message> = [
              ...next,
              new Message({ role: "assistant", content: response.text }),
            ];
            yield* saveHistory(updated);

            const out: typeof PromptResponse.Type = {
              text: response.text,
              finishReason: response.finishReason,
              toolCallCount: response.toolCalls.length,
              model: input.model ?? DEFAULT_MODEL,
              messageCount: updated.length,
            };
            return out;
          }).pipe(
            Effect.provide(toolkitLayer),
            Effect.provide(clientLayer),
            Effect.orDie,
          ),

        streamPrompt: (input: {
          message: string;
          model?: string;
          skill?: string;
        }) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const skillBody = yield* loadSkill(input.skill ?? "support");
              const history = yield* loadHistory;
              const next: ReadonlyArray<Message> = [
                ...history,
                new Message({ role: "user", content: input.message }),
              ];

              // Mutable accumulator captured by both the mapping stage
              // and the ensuring hook, so we always persist whatever
              // text we managed to receive — including on disconnect.
              const accumulator = { text: "", toolCalls: 0, finished: false };
              let finalReason = "interrupted";

              const persist = Effect.suspend(() => {
                const reason = accumulator.finished
                  ? finalReason
                  : "interrupted";
                const updated: ReadonlyArray<Message> = [
                  ...next,
                  new Message({
                    role: "assistant",
                    content: accumulator.text,
                  }),
                ];
                return saveHistory(updated).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      // record final reason so callers reading via
                      // history endpoints see consistent state
                      finalReason = reason;
                    }),
                  ),
                );
              });

              const stream = LanguageModel.streamText({
                prompt: Prompt.fromMessages(buildMessages(skillBody, next)),
                toolkit,
              }).pipe(
                Stream.provide(
                  OpenRouterLanguageModel.model(input.model ?? DEFAULT_MODEL),
                ),
              );

              const mapPart = Filter.make(
                (
                  part: Stream.Success<typeof stream>,
                ): Result.Result<
                  | StreamPartTextDelta
                  | StreamPartToolCall
                  | StreamPartToolResult
                  | StreamPartDone,
                  void
                > => {
                  switch (part.type) {
                    case "text-delta": {
                      accumulator.text += part.delta;
                      return Result.succeed(
                        new StreamPartTextDelta({ delta: part.delta }),
                      );
                    }
                    case "tool-call": {
                      accumulator.toolCalls += 1;
                      return Result.succeed(
                        new StreamPartToolCall({
                          id: part.id,
                          name: part.name,
                          params: part.params,
                        }),
                      );
                    }
                    case "tool-result": {
                      return Result.succeed(
                        new StreamPartToolResult({
                          id: part.id,
                          result: part.result,
                          isFailure: part.isFailure,
                        }),
                      );
                    }
                    case "finish": {
                      accumulator.finished = true;
                      finalReason = part.reason;
                      return Result.succeed(
                        new StreamPartDone({
                          finishReason: part.reason,
                          toolCallCount: accumulator.toolCalls,
                        }),
                      );
                    }
                    default:
                      return Result.fail(undefined);
                  }
                },
              );

              return stream.pipe(
                Stream.filterMap(mapPart),
                Stream.ensuring(persist.pipe(Effect.orDie)),
              );
            }),
          ).pipe(
            Stream.provide(toolkitLayer),
            Stream.provide(clientLayer),
            Stream.orDie,
          ),

        history: () => loadHistory,

        reset: () => state.storage.delete("history").pipe(Effect.asVoid),
      };
    });
  }),
) {}
