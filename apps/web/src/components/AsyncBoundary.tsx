import { AsyncResult } from "effect/unstable/reactivity"
import * as React from "react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { errorCopy } from "../errorCopy.ts"

/** True when a success value is an empty array (or any array-like with `length === 0`). */
function isEmpty(value: unknown): boolean {
  if (typeof value === "object" && value !== null && "length" in value) {
    const length = value.length
    return typeof length === "number" && length === 0
  }
  return false
}

/**
 * Renders an `AsyncResult` across its three states: skeleton rows while pending,
 * a destructive `Alert` with actionable {@link errorCopy} (plus an optional
 * Retry) on failure, and `children(value)` on success. When `empty` is provided
 * and the success value is an empty collection, `empty` is shown instead.
 */
export function AsyncBoundary<A>(props: {
  readonly result: AsyncResult.AsyncResult<A, unknown>
  readonly children: (value: A) => React.ReactNode
  readonly empty?: React.ReactNode
  readonly onRetry?: () => void
}): React.ReactNode {
  return AsyncResult.match(props.result, {
    onInitial: () => (
      <div role="status" aria-busy={true} className="grid gap-2">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    ),
    onFailure: ({ cause }) => {
      const copy = errorCopy(cause)
      return (
        <Alert variant="destructive">
          <AlertTitle>{copy.title}</AlertTitle>
          <AlertDescription>{copy.detail}</AlertDescription>
          {props.onRetry !== undefined ? (
            <Button variant="outline" size="sm" className="mt-2 w-fit" onClick={props.onRetry}>
              Retry
            </Button>
          ) : null}
        </Alert>
      )
    },
    onSuccess: ({ value }) => {
      if (props.empty !== undefined && isEmpty(value)) return props.empty
      return props.children(value)
    },
  })
}
