import { cva } from "class-variance-authority"
import { cn } from "@/lib/utils"

const statusPillVariants = cva(
  "font-mono rounded-full inline-flex items-center gap-1.5 px-2 py-0.5 text-[0.72rem] border",
  {
    variants: {
      state: {
        success: "text-success border-success/40 bg-success/10",
        warning: "text-warning border-warning/40 bg-warning/10",
        danger: "text-destructive border-destructive/40 bg-destructive/10",
        accent: "text-primary border-accent-line bg-accent-ghost",
        neutral: "text-muted-foreground border-border bg-surface-2",
      },
    },
    defaultVariants: {
      state: "neutral",
    },
  },
)

/** A compact mono status badge whose color maps to a semantic state. */
export function StatusPill({
  state,
  label,
  dot,
}: {
  state: "success" | "warning" | "danger" | "neutral" | "accent"
  label: string
  dot?: boolean
}) {
  return (
    <span className={cn(statusPillVariants({ state }))}>
      {dot ? <span className="w-1.5 h-1.5 rounded-full bg-current" /> : null}
      {label}
    </span>
  )
}
