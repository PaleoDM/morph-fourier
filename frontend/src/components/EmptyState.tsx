import { FolderOpen } from "lucide-react"

/**
 * Shown when the backend discovers no series under the photos root. Series =
 * immediate subfolders of the photos directory, so the fix is always "add a
 * folder of photos". Series-agnostic copy — nothing hyoid-specific.
 */
export function EmptyState() {
  return (
    <div className="flex h-full flex-1 items-center justify-center p-8">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-6 flex size-16 items-center justify-center rounded-full bg-accent text-accent-foreground">
          <FolderOpen className="size-8" />
        </div>
        <h2 className="text-xl font-semibold tracking-tight">No series found</h2>
        <p className="mt-3 text-sm text-muted-foreground">
          Drop one folder of photos per series into the{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
            photos/
          </code>{" "}
          directory, then reload. Each immediate subfolder becomes an
          independently-analysed series named after the folder.
        </p>
      </div>
    </div>
  )
}
