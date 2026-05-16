// Declare .md modules as text so `import x from "./foo.md" with { type: "text" }`
// typechecks. Rolldown (via @distilled.cloud/cloudflare-rolldown-plugin) and Bun
// both honor the `type: "text"` import attribute at bundle/runtime.
declare module "*.md" {
  const content: string
  export default content
}
