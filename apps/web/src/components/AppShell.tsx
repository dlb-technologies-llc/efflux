import { Menu, Moon, Sun, Zap } from "lucide-react"
import type * as React from "react"

import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"

import { StatusPill } from "./StatusPill.tsx"
import { useTheme } from "../theme.ts"

/** The efflux wordmark: a cyan energy mark, the lowercase product name, and a subtle build badge. */
function Wordmark(): React.ReactNode {
  return (
    <div className="flex items-center gap-2">
      <Zap className="size-5 text-primary" aria-hidden="true" />
      <span className="font-semibold tracking-tight lowercase">efflux</span>
      <StatusPill state="accent" label="beta" dot={false} />
    </div>
  )
}

/** A ghost icon button that flips light/dark and reflects the current resolved theme, labelled for assistive tech. */
function ThemeToggle(): React.ReactNode {
  const { resolved, toggle } = useTheme()
  const Icon = resolved === "dark" ? Sun : Moon
  const label = resolved === "dark" ? "Switch to light theme" : "Switch to dark theme"
  return (
    <Button variant="ghost" size="icon" aria-label={label} onClick={toggle}>
      <Icon />
    </Button>
  )
}

/**
 * The application frame: a fixed TopBar above a three-column body — sessions rail, main, and inspector.
 * Below `md` the sessions rail collapses into a Sheet opened from a TopBar menu button while main and
 * inspector stack. Every region is a slot; the shell never imports a panel component itself.
 */
export function AppShell({
  sessions,
  main,
  inspector,
  topBarActions,
}: {
  sessions: React.ReactNode
  main: React.ReactNode
  inspector: React.ReactNode
  topBarActions?: React.ReactNode
}): React.ReactNode {
  return (
    <div className="h-dvh grid grid-rows-[auto_1fr] bg-background text-foreground">
      <header className="flex items-center gap-3 px-4 h-14 border-b border-border">
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open sessions">
              <Menu />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-72 p-0" aria-describedby={undefined}>
            <SheetHeader className="sr-only">
              <SheetTitle>Sessions</SheetTitle>
            </SheetHeader>
            <div className="min-h-0 overflow-y-auto">{sessions}</div>
          </SheetContent>
        </Sheet>
        <Wordmark />
        <div className="ml-auto flex items-center gap-2">
          {topBarActions}
          <ThemeToggle />
        </div>
      </header>
      <div className="min-h-0 overflow-x-hidden grid grid-cols-1 grid-rows-[minmax(0,1fr)_auto] md:grid-cols-[260px_minmax(0,1fr)_minmax(320px,420px)] md:grid-rows-1">
        <aside className="hidden md:block min-h-0 overflow-y-auto border-r border-border">
          {sessions}
        </aside>
        <main className="flex flex-col min-h-0">{main}</main>
        <aside className="min-h-0 overflow-y-auto border-l border-border">{inspector}</aside>
      </div>
    </div>
  )
}
