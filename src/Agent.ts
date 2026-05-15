import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";
import {
  OpenRouterClient,
  OpenRouterLanguageModel,
} from "@effect/ai-openrouter";
import { OpenRouterKey } from "./Secrets.ts";
import { Sandbox } from "./Sandbox.ts";
import { Skills } from "./Skills.ts";

const DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";

export class Message extends Schema.Class<Message>("Message")({
  role: Schema.Literals(["user", "assistant"]),
  content: Schema.String,
}) {}

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

      return {
        prompt: (input: { message: string; model?: string; skill?: string }) =>
          Effect.gen(function* () {
            const skillBody = yield* loadSkill(input.skill ?? "support");
            const history = yield* loadHistory;
            const next: ReadonlyArray<Message> = [
              ...history,
              new Message({ role: "user", content: input.message }),
            ];

            const messages = [
              ...(skillBody
                ? [Prompt.makeMessage("system", { content: skillBody })]
                : []),
              ...next.map((m) =>
                Prompt.makeMessage(m.role, {
                  content: [Prompt.makePart("text", { text: m.content })],
                }),
              ),
            ];

            const response = yield* LanguageModel.generateText({
              prompt: Prompt.fromMessages(messages),
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

            return {
              text: response.text,
              finishReason: response.finishReason,
              toolCallCount: response.toolCalls.length,
              model: input.model ?? DEFAULT_MODEL,
              messageCount: updated.length,
            };
          }).pipe(
            Effect.provide(toolkitLayer),
            Effect.provide(clientLayer),
            Effect.orDie,
          ),

        history: () => loadHistory,

        reset: () => state.storage.delete("history").pipe(Effect.asVoid),
      };
    });
  }),
) {}
