import type { SkillSummary } from "@efflux/shared"
import * as React from "react"
import { cn } from "@/lib/utils"

/** DOM id of the autocomplete listbox, shared with the composer so the textarea's `aria-controls`/`aria-activedescendant` can reference it. */
export const SLASH_MENU_LISTBOX_ID = "slash-command-listbox"

/** Stable id for the option row at `index`, referenced by the textarea's `aria-activedescendant` while that row is highlighted. */
export const slashOptionId = (index: number): string => `${SLASH_MENU_LISTBOX_ID}-option-${index}`

interface SlashCommandMenuProps {
  readonly items: ReadonlyArray<SkillSummary>
  readonly activeIndex: number
  readonly onSelect: (name: string) => void
}

/**
 * Autocomplete list of skill names anchored ABOVE the composer input. Purely
 * presentational and fully controlled: the parent (`Chat`) owns filtering, the
 * highlighted index, and all keyboard navigation. Exposes ARIA `listbox`/`option`
 * semantics (the composer wires the matching `combobox` attributes onto the
 * textarea) and keeps the highlighted row scrolled into view. Rows use
 * `onMouseDown` `preventDefault` so a click never blurs the textarea before
 * `onSelect` fires, and carry `tabIndex={-1}` because the textarea keeps focus and
 * drives the active option through `aria-activedescendant`.
 */
export function SlashCommandMenu({ items, activeIndex, onSelect }: SlashCommandMenuProps): React.JSX.Element {
  const activeRef = React.useRef<HTMLButtonElement | null>(null)
  React.useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" })
  }, [activeIndex])

  return (
    <div className="absolute bottom-full left-0 right-0 mb-1 max-h-56 overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-md">
      <div id={SLASH_MENU_LISTBOX_ID} role="listbox" className="py-1">
        {items.map((item, index) => (
          <button
            key={item.name}
            ref={index === activeIndex ? activeRef : null}
            id={slashOptionId(index)}
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            tabIndex={-1}
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
        ))}
      </div>
    </div>
  )
}
