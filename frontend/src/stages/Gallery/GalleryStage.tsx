import { useMemo } from "react"
import { AlertTriangleIcon, DownloadIcon, UnlockIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useCuration, useSeriesRecords } from "@/api/curation"
import { useCrop } from "@/api/crop"
import { useOrient } from "@/api/orient"
import { useMask } from "@/api/mask"
import { useExport } from "@/api/gallery"
import { useActiveSeriesStore } from "@/state/useActiveSeriesStore"
import { canonicalRecords } from "@/lib/canonicals"
import { OutlineThumb } from "./OutlineThumb"
import { galleryReadiness } from "./readiness"

/**
 * Stage 5 — Outline gallery. A read-only, shape-only grid of every canonical's
 * saved outline (closed polygon on a neutral card, no source image) — the "compare
 * shapes across specimens at a glance" sanity check. Canonicals missing an upstream
 * artifact (orient / crop / mask) are flagged in a panel, never silently omitted,
 * so "N of M ready" is honest. An Export button writes the Momocs bundle.
 *
 * Gated on Stage 4 (Mask) being locked — the outlines aren't settled until then.
 */
export function GalleryStage() {
  const seriesKey = useActiveSeriesStore((s) => s.activeSeriesKey)

  const recordsQuery = useSeriesRecords(seriesKey)
  const curationQuery = useCuration(seriesKey)
  const orientQuery = useOrient(seriesKey)
  const cropQuery = useCrop(seriesKey)
  const maskQuery = useMask(seriesKey)

  const doExport = useExport(seriesKey ?? "")

  const canon = useMemo(
    () => canonicalRecords(recordsQuery.data?.records ?? [], curationQuery.data),
    [recordsQuery.data, curationQuery.data],
  )

  const { ready, missing } = useMemo(
    () => galleryReadiness(canon, orientQuery.data, cropQuery.data, maskQuery.data),
    [canon, orientQuery.data, cropQuery.data, maskQuery.data],
  )

  const masks = maskQuery.data?.masks ?? {}
  const maskLocked = maskQuery.data?.lockedAt != null

  const isLoading =
    recordsQuery.isLoading ||
    curationQuery.isLoading ||
    orientQuery.isLoading ||
    cropQuery.isLoading ||
    maskQuery.isLoading
  const isError =
    recordsQuery.isError ||
    curationQuery.isError ||
    orientQuery.isError ||
    cropQuery.isError ||
    maskQuery.isError

  if (!seriesKey || isLoading) return <GallerySkeleton />

  if (isError) {
    return (
      <StageMessage
        icon={<AlertTriangleIcon className="size-7" />}
        title="Couldn’t load gallery data"
        body="The records, curation, orient, crop, or mask request failed. Make sure the backend is running."
        action={
          <Button
            variant="outline"
            onClick={() => {
              void recordsQuery.refetch()
              void curationQuery.refetch()
              void orientQuery.refetch()
              void cropQuery.refetch()
              void maskQuery.refetch()
            }}
          >
            Retry
          </Button>
        }
      />
    )
  }

  if (canon.length === 0) {
    return (
      <StageMessage
        title="No canonical specimens yet"
        body="Mark one accepted photo per specimen as canonical in Stage 1 — Curation, then work through Orient, Crop, and Mask."
      />
    )
  }

  // Soft gate (Phase 10): the gallery renders on whatever outlines exist so a
  // partially-masked series can still be reviewed and exported. When the mask isn't
  // locked yet, we show a non-blocking notice that the outlines aren't final rather
  // than blocking the whole stage — the "N of M ready" count keeps it honest.

  return (
    <div className="flex h-full flex-col gap-4">
      {/* Header */}
      <div>
        <p className="text-sm font-medium text-muted-foreground">Stage 5</p>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Gallery</h1>
          <div className="flex items-center gap-3">
            <span className="text-sm tabular-nums text-muted-foreground">
              {ready.length} of {canon.length} ready
            </span>
            <Button
              size="sm"
              className="gap-1.5"
              disabled={ready.length === 0 || doExport.isPending}
              onClick={() => doExport.mutate()}
              title={
                ready.length === 0
                  ? "No ready outlines to export"
                  : "Write the Momocs export bundle (images + outlines + manifest)"
              }
            >
              <DownloadIcon className="size-4" />
              {doExport.isPending ? "Exporting…" : "Export"}
            </Button>
          </div>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Every specimen’s outline, shape-only on a neutral card. Scan for a shape
          that looks wrong — a long-narrow blob where you expected a wide V means the
          mask grabbed the wrong thing; fix it back in Stage 4.
        </p>
      </div>

      {/* Soft-gate notice: outlines are still editable until Mask is locked. */}
      {!maskLocked && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          <UnlockIcon className="size-4 shrink-0" />
          <span>
            Mask isn’t locked yet — these outlines can still change. You can review and
            export what’s ready now; re-export after locking Stage 4 for the final set.
          </span>
        </div>
      )}

      {/* Missing-artifact panel — flagged, not silently omitted. */}
      {missing.length > 0 && (
        <div className="rounded-lg border border-warning/40 bg-warning/10 px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <AlertTriangleIcon className="size-4 text-warning" />
            {missing.length} specimen{missing.length === 1 ? "" : "s"} not ready — missing
            an upstream artifact (excluded from the gallery and export)
          </div>
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {missing.map(({ record, lacks }) => (
              <li key={record.recordKey} className="tabular-nums">
                <span className="font-medium text-foreground">{record.specimenId}</span>{" "}
                — needs {lacks.join(", ")}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Shape-only outline grid */}
      <section className="min-h-0 flex-1 overflow-y-auto">
        {ready.length === 0 ? (
          <div className="mt-8 text-center text-sm text-muted-foreground">
            No outlines are ready yet. Complete Orient, Crop, and Mask for at least one
            canonical.
          </div>
        ) : (
          <div className="flex flex-wrap gap-3">
            {ready.map((record) => (
              <OutlineThumb
                key={record.recordKey}
                record={record}
                mask={masks[record.recordKey]!}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function StageMessage({
  icon,
  title,
  body,
  action,
}: {
  icon?: React.ReactNode
  title: string
  body: string
  action?: React.ReactNode
}) {
  return (
    <div className="mx-auto mt-16 max-w-md text-center">
      {icon && (
        <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-full bg-muted text-muted-foreground">
          {icon}
        </div>
      )}
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{body}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

function GallerySkeleton() {
  return (
    <div className="flex h-full flex-col gap-4">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-10 w-full max-w-xl" />
      <div className="flex flex-wrap gap-3">
        {Array.from({ length: 12 }).map((_, i) => (
          <Skeleton key={i} className="size-40" />
        ))}
      </div>
    </div>
  )
}
