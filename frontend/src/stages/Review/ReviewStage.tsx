import { useMemo, useState } from "react"
import { AlertTriangleIcon, FlagIcon, LockIcon, SparklesIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { useCuration, useSeriesRecords } from "@/api/curation"
import { useCrop } from "@/api/crop"
import { useOrient } from "@/api/orient"
import { useMask } from "@/api/mask"
import { useAutoResults } from "@/api/automate"
import { useLockReview } from "@/api/review"
import { useActiveSeriesStore } from "@/state/useActiveSeriesStore"
import { canonicalRecords } from "@/lib/canonicals"
import type { PhotoRecord } from "@/types/domain"
import { ReviewThumb } from "./ReviewThumb"
import { ReviewWizard } from "./ReviewWizard"
import { reviewRank } from "./status"

/**
 * Stage 4 — Review & Finalize (Phase 11D). A grid of every canonical (primed + auto),
 * shape-only, with a status/flag chip. Flagged low-confidence + detection-failure
 * specimens surface first so the user fixes the genuinely hard ones before anything
 * else. Clicking any specimen opens the same box-frame wizard as Prime to re-crop /
 * re-orient / re-mask it, overwriting its geometry. A Lock finalizes the set and gates
 * Stage 5 (Gallery). Gated on Automate having run (there's nothing to review before it).
 */
export function ReviewStage() {
  const seriesKey = useActiveSeriesStore((s) => s.activeSeriesKey)

  const recordsQuery = useSeriesRecords(seriesKey)
  const curationQuery = useCuration(seriesKey)
  const cropQuery = useCrop(seriesKey)
  const orientQuery = useOrient(seriesKey)
  const maskQuery = useMask(seriesKey)
  const autoResultsQuery = useAutoResults(seriesKey)
  const lock = useLockReview(seriesKey ?? "")

  const [activeRecord, setActiveRecord] = useState<PhotoRecord | null>(null)

  const canon = useMemo(
    () => canonicalRecords(recordsQuery.data?.records ?? [], curationQuery.data),
    [recordsQuery.data, curationQuery.data],
  )

  const masks = maskQuery.data?.masks ?? {}
  const crops = cropQuery.data?.crops ?? {}
  const orients = orientQuery.data?.orientations ?? {}
  const results = autoResultsQuery.data?.results ?? {}
  const maskLocked = maskQuery.data?.lockedAt != null

  // Flagged-first ordering; stable within a rank by canonical order. Depends on the
  // query data (stable identity), not the `?? {}` derivations (fresh every render).
  const ordered = useMemo(() => {
    const r = autoResultsQuery.data?.results ?? {}
    const m = maskQuery.data?.masks ?? {}
    return canon
      .map((record, i) => ({
        record,
        rank: reviewRank(r[record.recordKey], m[record.recordKey] != null),
        i,
      }))
      .sort((a, b) => a.rank - b.rank || a.i - b.i)
      .map((x) => x.record)
  }, [canon, autoResultsQuery.data, maskQuery.data])

  const flaggedCount = useMemo(() => {
    const r = autoResultsQuery.data?.results ?? {}
    return canon.filter((rec) => r[rec.recordKey]?.flagged).length
  }, [canon, autoResultsQuery.data])
  const readyCount = useMemo(() => {
    const m = maskQuery.data?.masks ?? {}
    return canon.filter((rec) => m[rec.recordKey] != null).length
  }, [canon, maskQuery.data])
  // Has Automate produced anything yet? (auto results OR any mask on a canonical)
  const hasRun = readyCount > 0 || Object.keys(results).length > 0

  const isLoading =
    recordsQuery.isLoading ||
    curationQuery.isLoading ||
    cropQuery.isLoading ||
    orientQuery.isLoading ||
    maskQuery.isLoading ||
    autoResultsQuery.isLoading
  const isError =
    recordsQuery.isError ||
    curationQuery.isError ||
    cropQuery.isError ||
    orientQuery.isError ||
    maskQuery.isError ||
    autoResultsQuery.isError

  if (!seriesKey || isLoading) return <ReviewSkeleton />

  if (isError) {
    return (
      <StageMessage
        icon={<AlertTriangleIcon className="size-7" />}
        title="Couldn’t load review data"
        body="A records, curation, crop, orient, mask, or auto-results request failed. Make sure the backend is running."
        action={
          <Button
            variant="outline"
            onClick={() => {
              void recordsQuery.refetch()
              void curationQuery.refetch()
              void cropQuery.refetch()
              void orientQuery.refetch()
              void maskQuery.refetch()
              void autoResultsQuery.refetch()
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
        body="Mark one accepted photo per specimen as canonical in Stage 1 — Curation, then prime and automate."
      />
    )
  }

  if (!hasRun) {
    return (
      <StageMessage
        icon={<SparklesIcon className="size-7" />}
        title="Nothing to review yet"
        body="Run Stage 3 — Automate to auto-detect, crop, orient, and mask the canonical set. Its results appear here for you to inspect and refine."
      />
    )
  }

  return (
    <div className="flex h-full flex-col gap-4">
      {/* Header */}
      <div>
        <p className="text-sm font-medium text-muted-foreground">Stage 4</p>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Review &amp; Finalize</h1>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-3 text-sm tabular-nums text-muted-foreground">
              {flaggedCount > 0 && (
                <span className="flex items-center gap-1 text-warning">
                  <FlagIcon className="size-4" />
                  {flaggedCount} flagged
                </span>
              )}
              <span>
                <span className="font-medium text-foreground">{readyCount}</span> of {canon.length} with an outline
              </span>
            </span>
            {maskLocked ? (
              <Badge variant="success" className="gap-1">
                <LockIcon className="size-3" />
                Finalized
              </Badge>
            ) : (
              <Button
                size="sm"
                className="gap-1.5"
                disabled={readyCount === 0 || lock.isPending}
                onClick={() => lock.mutate()}
                title={
                  readyCount === 0
                    ? "No outlines to lock yet"
                    : "Finalize the set and unlock Stage 5 (Gallery)"
                }
              >
                <LockIcon className="size-4" />
                {lock.isPending ? "Locking…" : "Lock & finalize"}
              </Button>
            )}
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
          Flagged specimens surface first. Click any specimen to re-crop, re-orient, and re-mask it
          with the same guided editor you used to prime. Lock when the set looks right — Gallery, EFA,
          PCA, and Morphospace read the same outlines.
        </p>
      </div>

      {maskLocked && (
        <div className="flex items-center gap-2 rounded-lg border border-success/40 bg-success/5 px-4 py-2.5 text-sm text-muted-foreground">
          <LockIcon className="size-4 shrink-0 text-success" />
          <span>
            This set is finalized — Stage 5 (Gallery) and the analysis stages are unlocked. You can
            still refine any specimen; re-lock afterwards to update the finalized timestamp.
          </span>
        </div>
      )}

      {/* Grid — flagged first */}
      <section className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-wrap gap-3">
          {ordered.map((record) => (
            <ReviewThumb
              key={record.recordKey}
              record={record}
              mask={masks[record.recordKey]}
              result={results[record.recordKey]}
              onRefine={setActiveRecord}
            />
          ))}
        </div>
      </section>

      {activeRecord && (
        <ReviewWizard
          seriesKey={seriesKey}
          record={activeRecord}
          cropBox={crops[activeRecord.recordKey]}
          angleDeg={orients[activeRecord.recordKey]?.angleDeg}
          onClose={() => setActiveRecord(null)}
        />
      )}
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

function ReviewSkeleton() {
  return (
    <div className="flex h-full flex-col gap-4">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-10 w-full max-w-xl" />
      <div className="flex flex-wrap gap-3">
        {Array.from({ length: 12 }).map((_, i) => (
          <Skeleton key={i} className="size-44" />
        ))}
      </div>
    </div>
  )
}
