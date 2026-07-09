/** Cap on tool/MCP output fed back into the prompt next hop, so one runaway result can't dwarf the context. */
export const MAX_TOOL_OUTPUT_CHARS = 30_000

/** Clamp prompt-bound text to {@link MAX_TOOL_OUTPUT_CHARS}, appending a truncation marker when cut. */
export const capForPrompt = (text: string): string =>
  text.length > MAX_TOOL_OUTPUT_CHARS
    ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n[output truncated]`
    : text
