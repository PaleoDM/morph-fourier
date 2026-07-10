import { AlertTriangle } from "lucide-react"

import { Button } from "@/components/ui/button"

/**
 * Shown when series discovery fails at the transport level — most commonly the
 * backend being down (in dev, the Vite proxy 500s when :8000 isn't up). Distinct
 * from EmptyState: an empty photos root is a valid, expected state; a failed
 * request is not, and the user's fix is "start/repair the backend, then retry".
 */
export function ErrorState({
  message,
  onRetry,
  isRetrying,
}: {
  message?: string
  onRetry: () => void
  isRetrying: boolean
}) {
  return (
    <div className="flex h-full flex-1 items-center justify-center p-8">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-6 flex size-16 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <AlertTriangle className="size-8" />
        </div>
        <h2 className="text-xl font-semibold tracking-tight">
          Couldn’t reach the backend
        </h2>
        <p className="mt-3 text-sm text-muted-foreground">
          The series list failed to load. Make sure the backend is running, then
          retry.
        </p>
        {message ? (
          <p className="mt-2 font-mono text-xs text-muted-foreground/80">
            {message}
          </p>
        ) : null}
        <Button
          className="mt-6"
          variant="outline"
          onClick={onRetry}
          disabled={isRetrying}
        >
          {isRetrying ? "Retrying…" : "Retry"}
        </Button>
      </div>
    </div>
  )
}
