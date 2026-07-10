import { Schema } from "effect"

/** Curated model IDs offered as suggestions in the web model picker. NOT a constraint on PromptRequest.model, which stays open — callers may pass any model. */
export const SUGGESTED_MODELS = Schema.Literals([
  "openai/gpt-4o-mini",
  "tencent/hy3:free",
  "openai/gpt-5.2",
  "anthropic/claude-sonnet-4.5",
  "google/gemini-2.5-flash",
  "deepseek/deepseek-chat",
])

/** A suggested model id. */
export type SuggestedModel = typeof SUGGESTED_MODELS.Type

/** The suggestion ids as a plain readonly string array for the picker dropdown. */
export const SUGGESTED_MODEL_IDS: ReadonlyArray<string> = SUGGESTED_MODELS.literals
