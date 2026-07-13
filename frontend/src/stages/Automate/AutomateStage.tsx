import { useMemo } from "react"
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  FlagIcon,
  Loader2Icon,
  SparklesIcon,
  WandSparklesIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useCuration, useSeriesRecords } from "@/api/curation"
import { useExemplars } from "@/api/exemplars"
import { useAutomate, useAutoResults } from "@/api/automate"
import { useActiveSeriesStore } from "@/state/useActiveSeriesStore"
import { canonicalRecords } from "@/lib/canonicals"
import { primingCount, type AutomateSummary } from "@/types/domain"

/**
 * Stage 3 — Automate (Phase 11D). One-click batch auto-detect: for every non-primed
 * canonical the backend takes the largest cohesive specimen blob, SAM box-predicts it,
 * matches it against the nearest primed exemplar, and auto-crops/orients/masks it —
 * carrying the primed exemplars forward into the same geometry state so the whole
 * canonical set flows downstream. Gated on a ready exemplar set (Stage 2 — Prime);
 * shows a progress spinner during the run and a per-batch outcome summary after.
 *
 * The run is synchronous (SAM box-predict ~0.5 s/photo on Apple Silicon). On an Intel
 * Mac a ~68-photo batch could take 10–20 min and will want a background-task +
 * progress-stream variant — flagged for later, not built here.
 */
export function AutomateStage() {
  const seriesKey = useActiveSeriesStore((s) => s.activeSeriesKey)

  const recordsQuery = useSeriesRecords(seriesKey)
  const curationQuery = useCuration(seriesKey)
  const exemplarsQuery = useExemplars(seriesKey)
  const autoResultsQuery = useAutoResults(seriesKey)
  const automate = useAutomate(seriesKey ?? "")

  const canon = useMemo(
    () => canonicalRecords(recordsQuery.data?.records ?? [], curationQuery.data),
    [recordsQuery.data, curationQuery.data],
  )

  const primedKeys = useMemo(() => {
    const canonSet = new Set(canon.map((r) => r.recordKey))
    return (exemplarsQuery.data?.exemplars ?? []).filter((e) => canonSet.has(e.recordKey))
  }, [canon, exemplarsQuery.data])

  const target = primingCount(canon.length)
  const primedCount = primedKeys.length
  const ready = primedCount >= target && primedCount > 0
  // Non-primed canonicals are the batch's work list.
  const toProcess = canon.length - primedCount

  // A prior run's results (auto_results.json) so re-opening the stage shows what's done.
  const priorResultCount = useMemo(
    () => Object.values(autoResultsQuery.data?.results ?? {}).filter((r) => r.source !== "primed").length,
    [autoResultsQuery.data],
  )

  const isLoading =
    recordsQuery.isLoading ||
    curationQuery.isLoading ||
    exemplarsQuery.isLoading ||
    autoResultsQuery.isLoading
  const isError =
    recordsQuery.isError || curationQuery.isError || exemplarsQuery.isError || autoResultsQuery.isError

  if (!seriesKey || isLoading) return <AutomateSkeleton />

  if (isError) {
    return (
      <StageMessage
        icon={<AlertTriangleIcon className="size-7" />}
        title="Couldn’t load automate data"
        body="The records, curation, exemplar, or auto-results request failed. Make sure the backend is running."
        action={
          <Button
            variant="outline"
            onClick={() => {
              void recordsQuery.refetch()
              void curationQuery.refetch()
              void exemplarsQuery.refetch()
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
        body="Mark one accepted photo per specimen as canonical in Stage 1 — Curation, then prime a diverse training set in Stage 2."
      />
    )
  }

  const summary = automate.data
  const running = automate.isPending

  return (
    <div className="flex h-full flex-col gap-4">
      {/* Header */}
      <div>
        <p className="text-sm font-medium text-muted-foreground">Stage 3</p>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Automate</h1>
          <div className="flex items-center gap-2 text-sm tabular-nums text-muted-foreground">
            <WandSparklesIcon className="size-4" />
            <span className="font-medium text-foreground">{primedCount}</span> primed ·{" "}
            <span className="font-medium text-foreground">{toProcess}</span> to auto-process
          </div>
        </div>
        <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
          Batch-detect, crop, orient, and mask every non-primed canonical by matching it against
          the primed exemplars. Low-confidence and failed specimens are flagged for you to fix
          first in Review — nothing is skipped.
        </p>
      </div>

      {/* Not-ready gate */}
      {!ready ? (
        <div className="rounded-lg border border-warning/40 bg-warning/10 p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <AlertTriangleIcon className="size-4 text-warning" />
            Prime a training set first
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            You’ve primed <span className="font-medium text-foreground">{primedCount}</span> of the
            recommended ~<span className="font-medium text-foreground">{target}</span> exemplars.
            Automate matches each remaining specimen against them, so a diverse primed set is
            required before the batch can run. Go to <span className="font-medium">Stage 2 — Prime</span>.
          </p>
        </div>
      ) : (
        <>
          {/* Trigger card */}
          <div className="rounded-lg border border-border bg-card/50 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm">
                <p className="font-medium">
                  {toProcess} specimen{toProcess === 1 ? "" : "s"} ready to auto-process
                </p>
                <p className="mt-0.5 text-muted-foreground">
                  {priorResultCount > 0 && !summary
                    ? `A previous run processed ${priorResultCount}. Re-running overwrites the auto results (primed + refined specimens are preserved).`
                    : `Using ${primedCount} primed exemplar${primedCount === 1 ? "" : "s"} as the match set.`}
                </p>
              </div>
              <Button
                size="lg"
                className="gap-2"
                disabled={running}
                onClick={() => automate.mutate()}
              >
                {running ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : (
                  <SparklesIcon className="size-4" />
                )}
                {running ? "Automating…" : priorResultCount > 0 ? "Re-run Automate" : "Automate all"}
              </Button>
            </div>
            {running && (
              <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2Icon className="size-3.5 animate-spin" />
                Running SAM over {toProcess} photo{toProcess === 1 ? "" : "s"} — this can take a
                moment. Keep this tab open.
              </p>
            )}
          </div>

          {/* Summary */}
          {summary && !running && <SummaryCard summary={summary} />}
        </>
      )}
    </div>
  )
}

function SummaryCard({ summary }: { summary: AutomateSummary }) {
  if (summary.skippedNoExemplars) {
    return (
      <div className="rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm">
        <span className="font-medium">No exemplars.</span> The batch found nothing to match against.
        Prime a training set in Stage 2 first.
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-success/40 bg-success/5 p-4">
      <div className="flex items-center gap-2 text-sm font-medium">
        <CheckCircle2Icon className="size-4 text-success" />
        Batch complete — {summary.processed} processed in {summary.elapsedSeconds.toFixed(1)}s
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Confident matches" value={summary.matched} tone="success" icon={<CheckCircle2Icon className="size-4" />} />
        <Stat label="Auto-isolated" value={summary.autoIsolated} tone="muted" icon={<SparklesIcon className="size-4" />} />
        <Stat label="Flagged" value={summary.flagged} tone="warning" icon={<FlagIcon className="size-4" />} />
        <Stat label="Primed carried" value={summary.primed} tone="muted" icon={<WandSparklesIcon className="size-4" />} />
        {summary.knownGoodPreserved > 0 && (
          <Stat label="Known good kept" value={summary.knownGoodPreserved} tone="muted" icon={<WandSparklesIcon className="size-4" />} />
        )}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        {summary.flagged > 0 ? (
          <>
            <span className="font-medium text-foreground">{summary.flaggedLowConfidence}</span> low-confidence
            and <span className="font-medium text-foreground">{summary.flaggedDetectionFailed}</span> detection
            failures need attention. Go to <span className="font-medium">Stage 4 — Review</span>, where they
            surface first.
          </>
        ) : (
          <>Every specimen was isolated and matched. Head to <span className="font-medium">Stage 4 — Review</span> to inspect and lock.</>
        )}
      </p>
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
  icon,
}: {
  label: string
  value: number
  tone: "success" | "warning" | "muted"
  icon: React.ReactNode
}) {
  const toneClass =
    tone === "success" ? "text-success" : tone === "warning" ? "text-warning" : "text-muted-foreground"
  return (
    <div className="rounded-md border border-border bg-background/60 p-3">
      <div className={"flex items-center gap-1.5 " + toneClass}>{icon}</div>
      <p className="mt-1.5 text-2xl font-semibold tabular-nums">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
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

function AutomateSkeleton() {
  return (
    <div className="flex h-full flex-col gap-4">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-20 w-full max-w-2xl" />
      <Skeleton className="h-28 w-full" />
    </div>
  )
}
