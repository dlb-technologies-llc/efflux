import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

/** Merge conditional class values and de-conflict Tailwind utilities. */
export function cn(...inputs: ReadonlyArray<ClassValue>) {
  return twMerge(clsx(inputs))
}
