import { useEffect, useMemo, useState } from "react"
import { AlertTriangleIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useCuration, useSeriesRecords, useSetDecision } from "@/api/curation"
import { useActiveSeriesStore } from "@/state/useActiveSeriesStore"
import { PhotoCard } from "./PhotoCard"
import { SpecimenGroupList } from "./SpecimenGroupList"
import { groupBySpecimen, isReviewed, specimenState } from "./grouping"
import type { PhotoDecision } from "@/types/domain"

/** Stable empty map so memo deps don't churn before curation data loads. */
const EMPTY_PHOTOS: Record<string, PhotoDecision> = {}

/**
 * Stage 1 — Curation. A specimen sidebar (grouped by `specimenKey`) beside a
 * panel showing every photo of the selected specimen side by side. Accept /
 * reject / canonical / notes save optimistically through `useSetDecision`.
 */
export function CurationStage() {
  const seriesKey = useActiveSeriesStore((s) => s.activeSeriesKey)

  const recordsQuery = useSeriesRecords(seriesKey)
  const curationQuery = useCuration(seriesKey)
  const setDecision = useSetDecision(seriesKey ?? "")

  const records = recordsQuery.data?.records
  const unparseable = recordsQuery.data?.unparseable ?? []
  const photos = curationQuery.data?.photos ?? EMPTY_PHOTOS

  const groups = useMemo(() => groupBySpecimen(records ?? []), [records])

  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  useEffect(() => {
    // Keep a valid selection as the series (and therefore groups) changes.
    if (groups.length === 0) {
      setSelectedKey(null)
    } else if (!groups.some((g) => g.specimenKey === selectedKey)) {
      setSelectedKey(groups[0].specimenKey)
    }
  }, [groups, selectedKey])

  const [dismissedUnparseable, setDismissedUnparseable] = useState(false)
  useEffect(() => setDismissedUnparseable(false), [seriesKey])

  const reviewedCount = useMemo(
    () => groups.filter((g) => isReviewed(specimenState(g, photos))).length,
    [groups, photos],
  )

  const isLoading = recordsQuery.isLoading || curationQuery.isLoading
  const isError = recordsQuery.isError || curationQuery.isError

  if (!seriesKey || isLoading) return <CurationSkeleton />

  if (isError) {
    return (
      <div className="mx-auto mt-16 max-w-md text-center">
        <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <AlertTriangleIcon className="size-7" />
        </div>
        <h2 className="text-lg font-semibold">Couldn’t load curation data</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The records or decisions request failed. Make sure the backend is running.
        </p>
        <Button
          variant="outline"
          className="mt-5"
          onClick={() => {
            void recordsQuery.refetch()
            void curationQuery.refetch()
          }}
        >
          Retry
        </Button>
      </div>
    )
  }

  if (groups.length === 0) {
    return (
      <div className="mx-auto mt-16 max-w-md text-center text-sm text-muted-foreground">
        No parseable photos in this series.
        {unparseable.length > 0 &&
          ` ${unparseable.length} file${unparseable.length === 1 ? "" : "s"} couldn't be parsed (below).`}
        {unparseable.length > 0 && !dismissedUnparseable && (
          <div className="mt-6 text-left">
            <UnparseablePanel
              files={unparseable}
              onDismiss={() => setDismissedUnparseable(true)}
            />
          </div>
        )}
      </div>
    )
  }

  const selectedGroup = groups.find((g) => g.specimenKey === selectedKey) ?? groups[0]
  const totalSpecimens = groups.length
  const progressPct = totalSpecimens === 0 ? 0 : (reviewedCount / totalSpecimens) * 100

  return (
    <div className="flex h-full flex-col gap-4">
      {/* Header: title + progress */}
      <div>
        <p className="text-sm font-medium text-muted-foreground">Stage 1</p>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Curation</h1>
          <div className="flex items-center gap-3">
            <span className="text-sm tabular-nums text-muted-foreground">
              {reviewedCount} / {totalSpecimens} specimens reviewed
            </span>
            <div
              className="h-2 w-40 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuenow={reviewedCount}
              aria-valuemin={0}
              aria-valuemax={totalSpecimens}
            >
              <div
                className="h-full rounded-full bg-primary transition-[width]"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      {unparseable.length > 0 && !dismissedUnparseable && (
        <UnparseablePanel
          files={unparseable}
          onDismiss={() => setDismissedUnparseable(true)}
        />
      )}

      {/* Body: specimen list + photo panel */}
      <div className="flex min-h-0 flex-1 gap-6">
        <aside className="w-64 shrink-0 overflow-y-auto pr-1">
          <SpecimenGroupList
            groups={groups}
            photos={photos}
            selectedKey={selectedGroup.specimenKey}
            onSelect={setSelectedKey}
          />
        </aside>

        <section className="min-w-0 flex-1 overflow-y-auto">
          <div className="mb-4">
            <h2 className="text-lg font-semibold">{selectedGroup.specimenId}</h2>
            <p className="text-sm text-muted-foreground">
              {selectedGroup.label} · {selectedGroup.records.length} photo
              {selectedGroup.records.length === 1 ? "" : "s"}
            </p>
          </div>
          <div className="flex flex-wrap gap-4">
            {selectedGroup.records.map((record) => (
              <PhotoCard
                key={record.recordKey}
                record={record}
                seriesKey={seriesKey}
                decision={photos[record.recordKey]}
                onSave={(recordKey, decision) =>
                  setDecision.mutate({ recordKey, decision })
                }
              />
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}

function UnparseablePanel({
  files,
  onDismiss,
}: {
  files: string[]
  onDismiss: () => void
}) {
  return (
    <div className="rounded-lg border border-warning/40 bg-warning/10 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-warning" />
          <div>
            <p className="text-sm font-medium">
              Couldn’t parse {files.length} file{files.length === 1 ? "" : "s"}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              These files don’t match the filename pattern and are excluded from
              curation. Rename them to include them.
            </p>
            <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-muted-foreground">
              {files.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          <XIcon className="size-4" />
        </Button>
      </div>
    </div>
  )
}

function CurationSkeleton() {
  return (
    <div className="flex h-full flex-col gap-4">
      <Skeleton className="h-8 w-48" />
      <div className="flex flex-1 gap-6">
        <div className="w-64 shrink-0 space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
        <div className="flex flex-1 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-80 w-72" />
          ))}
        </div>
      </div>
    </div>
  )
}
