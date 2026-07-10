import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { readDevVars, resolveApiToken } from "../../scripts/devvars.ts"

process.env.VITE_API_TOKEN = resolveApiToken(
  process.env.VITE_API_TOKEN,
  readDevVars(fileURLToPath(new URL("../../.dev.vars", import.meta.url))),
)

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    proxy: {
      "/agents": "http://localhost:8787",
      "/skills": "http://localhost:8787",
      "/tasks": "http://localhost:8787",
      "/meta": "http://localhost:8787",
    },
  },
})
