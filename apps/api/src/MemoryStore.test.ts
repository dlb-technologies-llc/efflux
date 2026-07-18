/**
 * Pins for `formatMemoryIndex`, the injected system-prompt block for
 * cross-session memory: the empty-index sentinel, entry ordering, and the
 * newline-collapse guard that stops a description from fabricating index
 * structure.
 *
 * @module
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { formatMemoryIndex } from "./MemoryStore.ts"

/** Two plain summaries in a fixed order, pinned so the index preserves it. */
const TWO_ENTRIES = [
  { name: "editor-preference", description: "Prefers vim keybindings", updatedAt: 1 },
  { name: "project-context", description: "Working on the efflux runtime", updatedAt: 2 },
]

/** A summary whose description smuggles `\n`/`\r\n` plus a fake markdown header. */
const SMUGGLING_ENTRY = [
  { name: "sneaky", description: "line1\nline2\r\n## fake", updatedAt: 3 },
]

describe("formatMemoryIndex", () => {
  it.effect("empty index renders the header, sentinel, and all three tool names", () =>
    Effect.sync(() => {
      const block = formatMemoryIndex([])
      expect(block).toContain("## Persistent memory")
      expect(block).toContain("No facts saved yet.")
      expect(block).toContain("memory_read")
      expect(block).toContain("memory_write")
      expect(block).toContain("memory_delete")
    }))

  it.effect("two entries render as `- name: description` lines in order", () =>
    Effect.sync(() => {
      const block = formatMemoryIndex(TWO_ENTRIES)
      const first = block.indexOf("- editor-preference: Prefers vim keybindings")
      const second = block.indexOf("- project-context: Working on the efflux runtime")
      expect(first).toBeGreaterThan(-1)
      expect(second).toBeGreaterThan(first)
    }))

  it.effect("newlines in a description collapse to spaces on one entry line", () =>
    Effect.sync(() => {
      const block = formatMemoryIndex(SMUGGLING_ENTRY)
      const fabricated = block
        .split("\n")
        .filter((line) => line.startsWith("## fake"))
      expect(fabricated).toStrictEqual([])
      expect(block).toContain("- sneaky: line1 line2 ## fake")
    }))
})
