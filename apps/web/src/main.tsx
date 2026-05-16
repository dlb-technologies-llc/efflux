import { RegistryContext } from "@effect/atom-react"
import { AtomRegistry } from "effect/unstable/reactivity"
import * as React from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App.tsx"

const container = document.getElementById("root")
if (container === null) {
  throw new Error("Missing #root element in index.html")
}

const registry = AtomRegistry.make()

createRoot(container).render(
  <React.StrictMode>
    <RegistryContext.Provider value={registry}>
      <App />
    </RegistryContext.Provider>
  </React.StrictMode>,
)
