import "./index.css"
import { RegistryProvider } from "@effect/atom-react"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { Toaster } from "@/components/ui/sonner"
import { App } from "./App.tsx"
import { ThemeProvider, useTheme } from "./theme.ts"

/** Mounts the sonner toaster bound to the provider's resolved theme. */
function AppToaster() {
  const { resolved } = useTheme()
  return <Toaster theme={resolved} />
}

const container = document.getElementById("root")
if (container === null) {
  throw new Error("Missing #root element in index.html")
}

createRoot(container).render(
  <StrictMode>
    <RegistryProvider>
      <ThemeProvider>
        <App />
        <AppToaster />
      </ThemeProvider>
    </RegistryProvider>
  </StrictMode>,
)
