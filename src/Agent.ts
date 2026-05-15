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

const Message = Schema.Struct({
  role: Schema.Literal("user", "assistant"),
  content: Schema.String,
});
type Message = typeof Message.Type;

export default class Agent extends Cloudflare.DurableObjectNamespace<Agent>()(
  "Agents",
  Effect.gen(function* () {
    // Per-class bindings, resolved once.
    const skills = yield* Cloudflare.R2Bucket.bind(Skills);
    const apiKey = yield* Cloudflare.Secret.bind(OpenRouterKey);
    const sandbox = yield* Cloudflare.Container.bind(Sandbox);

    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      const container = yield* Cloudflare.start(sandbox);

      // OpenRouter client layer, built once per DO instance.
      const clientLayer = OpenRouterClient.layer({
        apiKey: Redacted.make(yield* apiKey),
      }).pipe(Layer.provide(FetchHttpClient.layer));

      // Tool the model can invoke. Runs inside the container sandbox.
      const Bash = Tool.make("bash", {
        description: "Execute a bash command in a sandboxed Linux container.",
        parameters: Schema.Struct({
          command: Schema.String.annotate({
            description: "The shell command to run, e.g. `grep -ri auth /workspace/kb`.",
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
            bash: ({ command }) =>
              container.exec(command).pipe(Effect.orDie),
          }),
        ),
      );

      const loadSkill = (name: string) =>
        skills.get(`skills/${name}.md`).pipe(
          Effect.flatMap((obj) =>
            obj === null
              ? Effect.succeed("")
              : obj.text(),
          ),
          Effect.map(stripFrontmatter),
          Effect.catchAll(() => Effect.succeed("")),
        );

      const loadHistory = state.storage
        .get<readonly Message[]>("history")
        .pipe(Effect.map((h) => h ?? []));

      const saveHistory = (h: readonly Message[]) =>
        state.storage.put("history", h);

      return {
        prompt: (input: { message: string; model?: string; skill?: string }) =>
          Effect.gen(function* () {
            const skill = yield* loadSkill(input.skill ?? "support");
            const history = yield* loadHistory;
            const next: readonly Message[] = [
              ...history,
              { role: "user" as const, content: input.message },
            ];

            const response = yield* LanguageModel.generateText({
              system: skill || undefined,
              prompt: Prompt.fromMessages(
                next.map((m) =>
                  m.role === "user"
                    ? Prompt.user(m.content)
                    : Prompt.assistant(m.content),
                ),
              ),
              toolkit,
            }).pipe(
              Effect.provide(
                OpenRouterLanguageModel.model(input.model ?? DEFAULT_MODEL),
              ),
            );

            const updated: readonly Message[] = [
              ...next,
              { role: "assistant" as const, content: response.text },
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

const FRONTMATTER = /^---\n[\s\S]*?\n---\n/;
const stripFrontmatter = (s: string) => s.replace(FRONTMATTER, "").trim();
