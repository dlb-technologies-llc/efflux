import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { Atom } from "effect/unstable/reactivity"
import * as React from "react"

/** The three user-selectable theme modes; `"system"` defers to the OS `prefers-color-scheme`. */
type Theme = "dark" | "light" | "system"

/** The concrete appearance applied to the document once `"system"` has been resolved. */
type Resolved = "dark" | "light"

const STORAGE_KEY = "efflux-theme"

/** Narrows a raw `localStorage` value to a {@link Theme}, rejecting unknown or absent entries. */
function isTheme(value: string | null): value is Theme {
  return value === "dark" || value === "light" || value === "system"
}

/** Seeds the theme from persisted `localStorage`, defaulting to `"dark"` when unset, invalid, or unavailable. */
function readSeed(): Theme {
  if (typeof localStorage === "undefined") return "dark"
  const stored = localStorage.getItem(STORAGE_KEY)
  return isTheme(stored) ? stored : "dark"
}

/** Resolves `"system"` to a concrete appearance via `prefers-color-scheme`; explicit modes pass through. */
function resolveTheme(theme: Theme): Resolved {
  if (theme !== "system") return theme
  if (typeof window === "undefined") return "dark"
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

/** Source-of-truth atom for the selected theme mode; seeded from `localStorage`, defaulting to dark. */
export const themeAtom = Atom.make<Theme>(readSeed())

/** Applies the resolved theme to `document.documentElement` (the `.dark` class) and persists the selection whenever it changes. */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = useAtomValue(themeAtom)
  React.useEffect(() => {
    if (resolveTheme(theme) === "dark") {
      document.documentElement.classList.add("dark")
    } else {
      document.documentElement.classList.remove("dark")
    }
    localStorage.setItem(STORAGE_KEY, theme)
  }, [theme])
  return React.createElement(React.Fragment, null, children)
}

/** Reads and mutates the theme: the raw mode, its resolved appearance, a setter, and a dark/light toggle. */
export function useTheme(): {
  theme: Theme
  resolved: Resolved
  setTheme: (t: Theme) => void
  toggle: () => void
} {
  const theme = useAtomValue(themeAtom)
  const setTheme = useAtomSet(themeAtom)
  const resolved = resolveTheme(theme)
  const toggle = () => {
    setTheme(resolved === "dark" ? "light" : "dark")
  }
  return { theme, resolved, setTheme, toggle }
}
