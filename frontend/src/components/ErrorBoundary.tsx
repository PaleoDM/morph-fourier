import { Component, type ErrorInfo, type ReactNode } from "react"
import { AlertTriangle } from "lucide-react"

import { Button } from "@/components/ui/button"

/**
 * Global render-error boundary. A thrown error anywhere in the subtree (a stage
 * screen crashing on malformed data, a lazy chunk failing to evaluate) is caught
 * here and rendered as a recoverable fallback — never a blank white screen.
 *
 * Two recovery affordances:
 *  - "Try again" clears the caught error and re-renders the same subtree (enough
 *    when the crash was transient — e.g. a chunk that failed to load once).
 *  - `resetKeys`: when any value in the array changes (the shell passes the active
 *    stage id), the boundary auto-resets, so navigating away from a broken stage
 *    recovers without a manual click.
 *
 * React error boundaries must be class components — there is no hook equivalent.
 */
interface ErrorBoundaryProps {
  children: ReactNode
  /** Changing any entry clears the error (e.g. the active stage id). */
  resetKeys?: readonly unknown[]
  /** Optional custom fallback; defaults to the recoverable panel below. */
  fallback?: (error: Error, reset: () => void) => ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface it in the console for the developer; there's no remote logging here.
    console.error("Render error caught by ErrorBoundary:", error, info)
  }

  componentDidUpdate(prev: ErrorBoundaryProps) {
    if (this.state.error && !keysEqual(prev.resetKeys, this.props.resetKeys)) {
      this.reset()
    }
  }

  reset = () => this.setState({ error: null })

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    if (this.props.fallback) return this.props.fallback(error, this.reset)
    return <DefaultFallback error={error} onReset={this.reset} />
  }
}

function keysEqual(a?: readonly unknown[], b?: readonly unknown[]): boolean {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  return a.every((v, i) => Object.is(v, b[i]))
}

function DefaultFallback({
  error,
  onReset,
}: {
  error: Error
  onReset: () => void
}) {
  return (
    <div className="flex h-full min-h-[60vh] flex-1 items-center justify-center p-8">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-6 flex size-16 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <AlertTriangle className="size-8" />
        </div>
        <h2 className="text-xl font-semibold tracking-tight">
          Something went wrong on this screen
        </h2>
        <p className="mt-3 text-sm text-muted-foreground">
          The view hit an unexpected error and stopped rendering. Your saved work is
          safe — it all lives on the backend. Try again, or switch to another stage.
        </p>
        <p className="mt-2 font-mono text-xs text-muted-foreground/80">
          {error.message}
        </p>
        <div className="mt-6 flex items-center justify-center gap-2">
          <Button variant="outline" onClick={onReset}>
            Try again
          </Button>
          <Button variant="ghost" onClick={() => window.location.reload()}>
            Reload app
          </Button>
        </div>
      </div>
    </div>
  )
}
