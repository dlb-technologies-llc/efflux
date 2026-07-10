import { JournalTodoWrite, type TodoItem } from "@effect-flue/shared"
import { Context, Effect, Layer } from "effect"
import type { AgentNamespace } from "./AgentStub.ts"
import { eventJson } from "./JournalWrite.ts"

/** Plain todo shape across the DO RPC fence (Schema.Class instances cannot cross it — see ISSUES.md). */
export interface PlainTodo {
  readonly content: string
  readonly status: string
}

/** Per-request handle to the session's journal-backed task list — a Context.Service the todo tools depend on, provided per-turn from the resolved Agent stub + this turn's seq (mirrors BashRunner). */
export class TodoStore extends Context.Service<TodoStore, {
  readonly read: Effect.Effect<ReadonlyArray<PlainTodo>>
  readonly write: (items: ReadonlyArray<TodoItem>) => Effect.Effect<void>
}>()("api/TodoStore") {}

/** Bind a TodoStore to one DO instance + turn: `read` folds the latest `todo-write`; `write` appends a new one stamped with `turn`. */
export const makeTodoStoreLayer = (
  agent: ReturnType<AgentNamespace["getByName"]>,
  turn: number,
): Layer.Layer<TodoStore> =>
  Layer.succeed(
    TodoStore,
    TodoStore.of({
      read: Effect.promise(() => agent.latestTodos()),
      write: (items) =>
        Effect.promise(() =>
          agent.appendEvents([eventJson(new JournalTodoWrite({ turn, items: [...items] }))]),
        ).pipe(Effect.asVoid),
    }),
  )

const MARK: Record<string, string> = { pending: " ", in_progress: "~", completed: "x" }

/** Render the task list as a compact checklist for prompt injection + tool replies; empty list → a stable sentinel. Accepts the plain or class shape structurally. */
export const formatTodos = (
  items: ReadonlyArray<{ readonly content: string; readonly status: string }>,
): string =>
  items.length === 0
    ? "(no todos)"
    : items.map((t) => `- [${MARK[t.status] ?? " "}] ${t.content}`).join("\n")
