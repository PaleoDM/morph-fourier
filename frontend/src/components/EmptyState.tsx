import { FolderOpen } from "lucide-react"

import { NewSeriesDialog } from "@/components/NewSeriesDialog"

/**
 * Shown when the backend discovers no series under the photos root. The primary
 * path is the in-app uploader (create a series + add photos, no file wrangling);
 * dropping a folder into `photos/` still works as a power-user fallback.
 * Series-agnostic copy — nothing dataset-specific.
 */
export function EmptyState() {
  return (
    <div className="flex h-full flex-1 items-center justify-center p-8">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-6 flex size-16 items-center justify-center rounded-full bg-accent text-accent-foreground">
          <FolderOpen className="size-8" />
        </div>
        <h2 className="text-xl font-semibold tracking-tight">No series yet</h2>
        <p className="mt-3 text-sm text-muted-foreground">
          Create a series and upload your specimen photos to get started. Each
          series is analysed on its own.
        </p>
        <div className="mt-6 flex justify-center">
          <NewSeriesDialog />
        </div>
        <p className="mt-6 text-xs text-muted-foreground">
          Prefer files? You can also drop one folder of photos per series into the{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">
            photos/
          </code>{" "}
          directory and reload.
        </p>
      </div>
    </div>
  )
}
