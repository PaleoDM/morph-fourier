import { AppShell } from "@/components/AppShell"
import { ErrorBoundary } from "@/components/ErrorBoundary"
import { Toaster } from "@/components/ui/sonner"

function App() {
  return (
    <>
      {/* Outermost catch: even a crash in the shell chrome (header/rail) lands on a
          recoverable fallback rather than a blank page. Per-stage crashes are caught
          closer, inside AppShell, so they don't take the whole app down. */}
      <ErrorBoundary>
        <AppShell />
      </ErrorBoundary>
      <Toaster richColors closeButton />
    </>
  )
}

export default App
