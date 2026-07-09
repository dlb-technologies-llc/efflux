import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/agents": "http://localhost:8787",
      "/skills": "http://localhost:8787",
      "/tasks": "http://localhost:8787",
      "/meta": "http://localhost:8787",
    },
  },
})
