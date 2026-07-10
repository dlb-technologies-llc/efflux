import type { Components } from "react-markdown"
import ReactMarkdown from "react-markdown"
import rehypeSanitize from "rehype-sanitize"
import remarkGfm from "remark-gfm"
import { cn } from "@/lib/utils"

const components: Components = {
  strong({ node, children, ...props }) {
    return (
      <strong className="font-semibold text-foreground" {...props}>
        {children}
      </strong>
    )
  },
  h3({ node, children, ...props }) {
    return (
      <h3 className="font-semibold tracking-tight mt-4 mb-2" {...props}>
        {children}
      </h3>
    )
  },
  h4({ node, children, ...props }) {
    return (
      <h4 className="font-semibold tracking-tight mt-4 mb-2" {...props}>
        {children}
      </h4>
    )
  },
  ul({ node, children, ...props }) {
    return (
      <ul
        className="list-disc pl-5 my-2 space-y-1 marker:text-accent-dim"
        {...props}
      >
        {children}
      </ul>
    )
  },
  ol({ node, children, ...props }) {
    return (
      <ol
        className="list-decimal pl-5 my-2 space-y-1 marker:text-accent-dim"
        {...props}
      >
        {children}
      </ol>
    )
  },
  a({ node, children, ...props }) {
    return (
      <a
        className="text-primary underline decoration-accent-line underline-offset-2"
        {...props}
      >
        {children}
      </a>
    )
  },
  code({ node, className, children, ...props }) {
    const isBlock =
      typeof className === "string" && className.startsWith("language-")
    return isBlock ? (
      <code className={cn("font-mono", className)} {...props}>
        {children}
      </code>
    ) : (
      <code
        className="font-mono text-[0.85em] bg-surface-2 border border-border text-primary rounded px-1 py-0.5"
        {...props}
      >
        {children}
      </code>
    )
  },
  pre({ node, children, ...props }) {
    return (
      <pre
        className="bg-bg-subtle border border-border rounded-lg p-3 overflow-x-auto my-2"
        {...props}
      >
        {children}
      </pre>
    )
  },
}

/** Render trusted-but-sanitized markdown with the Efflux prose styling. */
export function Markdown({ content }: { content: string }) {
  return (
    <div className="text-sm leading-relaxed text-foreground break-words space-y-2">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
