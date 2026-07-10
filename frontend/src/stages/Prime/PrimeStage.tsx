import { useMemo, useState } from "react"
import { AlertTriangleIcon, SparklesIcon, WandSparklesIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useCuration, useSeriesRecords } from "@/api/curation"
import { useDeleteExemplar, useExemplars } from "@/api/exemplars"
import { useActiveSeriesStore } from "@/state/useActiveSeriesStore"
import { canonicalRecords } from "@/lib/canonicals"
import { primingCount, type Exemplar, type PhotoRecord } from "@/types/domain"
import { diversityStat } from "./diversity"
import { PrimeThumb } from "./PrimeThumb"
import { PrimeWizard } from "./PrimeWizard"

/**
 * Stage 2 — Prime (Phase 11C). The user fully processes a small, diverse training
 * set of exemplars — crop → SAM → mask → orient each — to build the ExemplarSet
 * that drives Stage 3 (Automate). This screen shows the canonical grid, a running
 * "N of ~K primed" counter, a diversity nudge (prime a spread across taxa/shape,
 * not the first N), and a readiness gate for Automate. Each specimen opens the
 * guided PrimeWizard. Gated on a canonical set existing (Stage 1 — Curation).
 */
export function PrimeStage() {
  const seriesKey = useActiveSeriesStore((s) => s.activeSeriesKey)

  const recordsQuery = useSeriesRecords(seriesKey)
  const curationQuery = useCuration(seriesKey)
  const exemplarsQuery = useExemplars(seriesKey)
  const deleteExemplar = useDeleteExemplar(seriesKey ?? "")

  const [activeRecord, setActiveRecord] = useState<PhotoRecord | null>(null)

  const canon = useMemo(
    () => canonicalRecords(recordsQuery.data?.records ?? [], curationQuery.data),
    [recordsQuery.data, curationQuery.data],
  )

  const exemplarByKey = useMemo(() => {
    const m = new Map<string, Exemplar>()
    for (const e of exemplarsQuery.data?.exemplars ?? []) m.set(e.recordKey, e)
    return m
  }, [exemplarsQuery.data])

  // Only count exemplars that are still in the canonical set (a de-canonicalised
  // specimen's stale exemplar shouldn't inflate the counter).
  const primedKeys = useMemo(() => {
    const s = new Set<string>()
    for (const r of canon) if (exemplarByKey.has(r.recordKey)) s.add(r.recordKey)
    return s
  }, [canon, exemplarByKey])

  const target = primingCount(canon.length)
  const primedCount = primedKeys.size
  const ready = primedCount >= target
  const diversity = useMemo(() => diversityStat(canon, primedKeys), [canon, primedKeys])

  const isLoading =
    recordsQuery.isLoading || curationQuery.isLoading || exemplarsQuery.isLoading
  const isError = recordsQuery.isError || curationQuery.isError || exemplarsQuery.isError

  if (!seriesKey || isLoading) return <PrimeSkeleton />

  if (isError) {
    return (
      <StageMessage
        icon={<AlertTriangleIcon className="size-7" />}
        title="Couldn’t load prime data"
        body="The records, curation, or exemplar request failed. Make sure the backend is running."
        action={
          <Button
            variant="outline"
            onClick={() => {
              void recordsQuery.refetch()
              void curationQuery.refetch()
              void exemplarsQuery.refetch()
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
        body="Mark one accepted photo per specimen as canonical in Stage 1 — Curation. Priming builds the training set from that canonical set."
      />
    )
  }

  return (
    <div className="flex h-full flex-col gap-4">
      {/* Header */}
      <div>
        <p className="text-sm font-medium text-muted-foreground">Stage 2</p>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Prime</h1>
          <div className="flex items-center gap-2 text-sm tabular-nums text-muted-foreground">
            <WandSparklesIcon className="size-4" />
            <span className="font-medium text-foreground">{primedCount}</span> of ~{target} primed
          </div>
        </div>
        <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
          Fully process a small, diverse training set — crop → SAM → mask → orient each. The
          pipeline then auto-detects, crops, orients, and masks every remaining specimen by
          matching against these exemplars.
        </p>
      </div>

      {/* Progress + diversity nudge / readiness gate */}
      <ProgressBanner
        primedCount={primedCount}
        target={target}
        ready={ready}
        totalGroups={diversity.totalGroups}
        coveredGroups={diversity.coveredGroups}
        suggestion={diversity.suggestion}
        onPrimeSuggestion={setActiveRecord}
      />

      {/* Grid */}
      <section className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-wrap gap-3">
          {canon.map((record) => (
            <PrimeThumb
              key={record.recordKey}
              record={record}
              seriesKey={seriesKey}
              primed={primedKeys.has(record.recordKey)}
              suggested={diversity.suggestion?.recordKey === record.recordKey}
              onPrime={setActiveRecord}
              onUnprime={(rk) => deleteExemplar.mutate(rk)}
            />
          ))}
        </div>
      </section>

      {activeRecord && (
        <PrimeWizard
          seriesKey={seriesKey}
          record={activeRecord}
          existing={exemplarByKey.get(activeRecord.recordKey)}
          onClose={() => setActiveRecord(null)}
        />
      )}
    </div>
  )
}

function ProgressBanner({
  primedCount,
  target,
  ready,
  totalGroups,
  coveredGroups,
  suggestion,
  onPrimeSuggestion,
}: {
  primedCount: number
  target: number
  ready: boolean
  totalGroups: number
  coveredGroups: number
  suggestion: PhotoRecord | null
  onPrimeSuggestion: (r: PhotoRecord) => void
}) {
  const pct = Math.min(100, Math.round((primedCount / Math.max(1, target)) * 100))

  return (
    <div
      className={
        "rounded-lg border p-4 " +
        (ready ? "border-success/50 bg-success/5" : "border-border bg-card/50")
      }
    >
      <div className="mb-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={"h-full rounded-full transition-all " + (ready ? "bg-success" : "bg-primary")}
          style={{ width: `${pct}%` }}
        />
      </div>
      {ready ? (
        <p className="text-sm">
          <span className="font-medium text-success">Ready to automate.</span>{" "}
          You’ve primed {primedCount} exemplars across {coveredGroups} of {totalGroups} shape
          groups. Run <span className="font-medium">Stage 3 — Automate</span> to auto-process the
          rest, then refine in Review.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
          <span className="text-muted-foreground">
            Prime <span className="font-medium text-foreground">{Math.max(0, target - primedCount)}</span>{" "}
            more · covering{" "}
            <span className="font-medium text-foreground">{coveredGroups}</span> of {totalGroups}{" "}
            shape groups. Aim for a diverse spread, not the first {target}.
          </span>
          {suggestion && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => onPrimeSuggestion(suggestion)}
            >
              <SparklesIcon className="size-3.5" />
              Prime suggested: {suggestion.specimenId}
            </Button>
          )}
        </div>
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

function PrimeSkeleton() {
  return (
    <div className="flex h-full flex-col gap-4">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-16 w-full max-w-2xl" />
      <div className="flex flex-1 flex-wrap gap-3">
        {Array.from({ length: 10 }).map((_, i) => (
          <Skeleton key={i} className="h-56 w-40" />
        ))}
      </div>
    </div>
  )
}
