/**
 * Pins for `formatTodos` in `Todo.ts` — the pure checklist renderer used for
 * prompt injection + tool replies. Freezes the empty-list sentinel and the
 * status-marker mapping (` `/`~`/`x`) plus item ordering so a later change to
 * the renderer cannot silently drift what the model sees. Also pins the
 * `todo_write` tool's parameter bound: `items` reuses `JournalTodoWrite`'s
 * already-bounded field (≤ 100), so an oversize list fails param decode in-band
 * instead of throwing a defect later at journal-encode time.
 *
 * @module
 */
import { describe, expect, it } from "@effect/vitest"
import { JournalTodoWrite } from "@efflux/shared"
import { Effect, Schema } from "effect"
import { formatTodos } from "./Todo.ts"

/** The `todo_write` tool's parameters schema — `items` reuses the journal's bounded field (≤ 100). */
const TodoWriteParams = Schema.Struct({ items: JournalTodoWrite.fields.items })
const decodeParams = Schema.decodeUnknownSync(TodoWriteParams)

/** Build `n` minimal valid TodoItem-shaped entries to exercise the length bound. */
const makeItems = (n: number) => Array.from({ length: n }, () => ({ content: "x", status: "pending" }))

describe("formatTodos", () => {
  it.effect("empty list -> sentinel", () =>
    Effect.sync(() => expect(formatTodos([])).toBe("(no todos)")))

  it.effect("mixed-status list -> marked checklist in order", () =>
    Effect.sync(() =>
      expect(
        formatTodos([
          { content: "a", status: "pending" },
          { content: "b", status: "in_progress" },
          { content: "c", status: "completed" },
        ]),
      ).toBe("- [ ] a\n- [~] b\n- [x] c")))
})

describe("todo_write parameters", () => {
  it.effect("100 items -> decodes", () =>
    Effect.sync(() => expect(decodeParams({ items: makeItems(100) }).items).toHaveLength(100)))

  it.effect("101 items -> rejected by the ≤100 bound", () =>
    Effect.sync(() => expect(() => decodeParams({ items: makeItems(101) })).toThrow()))
})
