/**
 * Pins for `formatTodos` in `Todo.ts` — the pure checklist renderer used for
 * prompt injection + tool replies. Freezes the empty-list sentinel and the
 * status-marker mapping (` `/`~`/`x`) plus item ordering so a later change to
 * the renderer cannot silently drift what the model sees.
 *
 * @module
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { formatTodos } from "./Todo.ts"

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
