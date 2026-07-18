/** Coerce a browser `File.name` into a string that always satisfies the contract's `WorkspaceFilename` (`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$`): replace disallowed chars with `_`, strip any leading non-alphanumerics (so the first char is alphanumeric), cap at 255, and fall back to `"file"` if nothing survives. */
export const toWorkspaceFilename = (raw: string): string => {
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^[^a-zA-Z0-9]+/, "").slice(0, 255)
  return cleaned.length > 0 ? cleaned : "file"
}
