import type { SkillSummary } from "@efflux/shared"
import type * as React from "react"
import { cn } from "@/lib/utils"

interface SlashCommandMenuProps {
  readonly items: ReadonlyArray<SkillSummary>
  readonly activeIndex: number
  readonly onSelect: (name: string) => void
}

/**
 * Autocomplete list of skill names anchored ABOVE the composer input. Purely
 * presentational and fully controlled: the parent (`Chat`) owns filtering, the
 * highlighted index, and all keyboard navigation. Rows use `onMouseDown`
 * `preventDefault` so a click never blurs the textarea before `onSelect` fires
 * (the same focus-retention trick the SessionSwitcher pickers use).
 */
export function SlashCommandMenu({ items, activeIndex, onSelect }: SlashCommandMenuProps): React.JSX.Element {
  return (
    <div className="absolute bottom-full left-0 right-0 mb-1 max-h-56 overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-md">
      <ul className="py-1">
        {items.map((item, index) => (
          <li key={item.name}>
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onSelect(item.name)}
              className={cn(
                "flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left",
                index === activeIndex ? "bg-surface-3" : "hover:bg-surface-2",
              )}
            >
              <span className="font-mono text-xs">/{item.name}</span>
              {item.description !== "" ? (
                <span className="line-clamp-1 text-[0.7rem] text-muted-foreground">{item.description}</span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
