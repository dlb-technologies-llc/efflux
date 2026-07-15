import type * as React from "react"
import { cn } from "@/lib/utils"

/**
 * The efflux house loading indicator: the branded three-line "flux" wave-mark
 * (the same waves as `apps/web/public/favicon.svg`) with each wave pulsing on a
 * staggered loop so the mark appears to flow downward. The cyan is the theme's
 * `primary` token (matching the favicon in dark mode) via `currentColor`, and the
 * motion is gated behind `motion-safe` so for reduced-motion users the waves hold
 * still at their graduated favicon opacities (1 / 0.6 / 0.3). Follows the shadcn
 * house idiom — `className` merges over the `size-5 text-primary` defaults (via
 * {@link cn}) and extra `svg` props pass through — while the visually-hidden
 * `label` keeps the indicator announced to assistive tech.
 */
export function Spinner({
  className,
  label = "Loading",
  ...props
}: React.ComponentProps<"svg"> & { readonly label?: string }): React.ReactNode {
  return (
    <span role="status" className="inline-flex items-center">
      <svg
        data-slot="spinner"
        viewBox="4 8 24 20"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
        aria-hidden="true"
        className={cn("size-5 text-primary", className)}
        {...props}
      >
        <title>{label}</title>
        <path
          d="M6 11c5 0 5 4 10 4s5-4 10-4"
          opacity={1}
          className="motion-safe:animate-flux"
          style={{ animationDelay: "0ms" }}
        />
        <path
          d="M6 17c5 0 5 4 10 4s5-4 10-4"
          opacity={0.6}
          className="motion-safe:animate-flux"
          style={{ animationDelay: "160ms" }}
        />
        <path
          d="M6 23c5 0 5 3 10 3"
          opacity={0.3}
          className="motion-safe:animate-flux"
          style={{ animationDelay: "320ms" }}
        />
      </svg>
      <span className="sr-only">{label}</span>
    </span>
  )
}
