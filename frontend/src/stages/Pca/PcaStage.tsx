import { useMemo, useState } from "react"
import { AlertTriangleIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { Skeleton } from "@/components/ui/skeleton"
import { useEfa } from "@/api/efa"
import { usePca, usePcaSettings, useRunPca } from "@/api/pca"
import { useActiveSeriesStore } from "@/state/useActiveSeriesStore"
import { DEFAULT_VARIANCE_TARGET } from "@/types/domain"
import { ScreeChart } from "./ScreeChart"
import { LoadingsHeatmap } from "./LoadingsHeatmap"

const PCT = (v: number) => `${(v * 100).toFixed(1)}%`

/**
 * Stage 7 — PCA over the EFA coefficient matrix. Fit, read the scree plot (per-PC
 * variance + cumulative), and choose how many components to retain (defaulting to
 * the variance-target count) for the downstream morphospace. A drift banner warns
 * when the EFA harmonics changed after PCA was last fit. Free-exploration stage —
 * no lock; carries `lastComputedAt`.
 */
export function PcaStage() {
  const seriesKey = useActiveSeriesStore((s) => s.activeSeriesKey)

  const efaQuery = useEfa(seriesKey)
  const settingsQuery = usePcaSettings(seriesKey)
  const hasRun = settingsQuery.data?.lastComputedAt != null
  const pcaQuery = usePca(seriesKey, hasRun)
  const runPca = useRunPca(seriesKey ?? "")

  const [retainedOverride, setRetained] = useState<number | null>(null)

  const varianceTarget =
    settingsQuery.data?.varianceTarget ?? DEFAULT_VARIANCE_TARGET

  // The default retained count = smallest PC reaching the variance target.
  const autoRetained = useMemo(() => {
    const cum = pcaQuery.data?.cumVarRatio
    if (!cum || cum.length === 0) return 1
    const idx = cum.findIndex((c) => c >= varianceTarget)
    return idx >= 0 ? idx + 1 : cum.length
  }, [pcaQuery.data, varianceTarget])

  const nComponents = pcaQuery.data?.nComponents ?? 1
  const retained = Math.min(
    Math.max(retainedOverride ?? settingsQuery.data?.nComponentsRetained ?? autoRetained, 1),
    nComponents,
  )
  const cumAtRetained = pcaQuery.data?.cumVarRatio[retained - 1] ?? null

  const efaReady =
    efaQuery.data?.lastComputedAt != null &&
    (efaQuery.data?.nSpecimensComputed ?? 0) >= 2

  const isLoading =
    !seriesKey ||
    efaQuery.isLoading ||
    settingsQuery.isLoading ||
    (hasRun && pcaQuery.isLoading)
  // A failed efa/settings fetch must not masquerade as "compute EFA first".
  const isError = efaQuery.isError || settingsQuery.isError

  if (isLoading) return <PcaSkeleton />

  if (isError) {
    return (
      <StageMessage
        icon={<AlertTriangleIcon className="size-7" />}
        title="Couldn’t load PCA inputs"
        body="The EFA or PCA-settings request failed. Make sure the backend is running, then retry."
        action={
          <Button
            variant="outline"
            onClick={() => {
              void efaQuery.refetch()
              void settingsQuery.refetch()
            }}
          >
            Retry
          </Button>
        }
      />
    )
  }

  if (!efaReady) {
    return (
      <StageMessage
        icon={<AlertTriangleIcon className="size-7" />}
        title="Compute EFA first"
        body="PCA is fit on the EFA coefficient matrix, and it needs at least two specimens. Set your harmonics and click Compute EFA in Stage 6, then come back."
      />
    )
  }

  const drift =
    hasRun &&
    settingsQuery.data?.harmonicsUsed != null &&
    efaQuery.data?.harmonics != null &&
    settingsQuery.data.harmonicsUsed !== efaQuery.data.harmonics

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      {/* Header */}
      <div>
        <p className="text-sm font-medium text-muted-foreground">Stage 7</p>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">PCA</h1>
          <div className="flex items-center gap-3">
            {hasRun && (
              <span className="text-sm tabular-nums text-muted-foreground">
                {nComponents} component{nComponents === 1 ? "" : "s"} ·{" "}
                {settingsQuery.data?.harmonicsUsed} harmonics
              </span>
            )}
            <Button
              onClick={() =>
                runPca.mutate({
                  nComponentsRetained: retainedOverride ?? null,
                  varianceTarget,
                })
              }
              disabled={runPca.isPending}
            >
              {runPca.isPending
                ? "Running…"
                : hasRun
                  ? "Re-run PCA"
                  : "Run PCA"}
            </Button>
          </div>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Reduce the EFA coefficients to the handful of axes that carry the shape
          variation. The retained count feeds the morphospace scatter in Stage 8.
        </p>
      </div>

      {/* Drift banner */}
      {drift && (
        <div className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
          <AlertTriangleIcon className="size-4 shrink-0 text-warning" />
          <span>
            EFA changed since PCA was last run — this fit used{" "}
            <span className="font-medium tabular-nums">
              {settingsQuery.data?.harmonicsUsed}
            </span>{" "}
            harmonics, EFA is now at{" "}
            <span className="font-medium tabular-nums">
              {efaQuery.data?.harmonics}
            </span>
            . Re-run PCA to sync.
          </span>
        </div>
      )}

      {!hasRun ? (
        <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          Run PCA to fit the model and see the scree plot.
        </div>
      ) : pcaQuery.data ? (
        <>
          {/* Scree */}
          <div className="rounded-lg border border-border bg-card p-4">
            <h3 className="text-sm font-medium">Scree plot</h3>
            <div className="mt-3">
              <ScreeChart
                varRatio={pcaQuery.data.varRatio}
                cumVarRatio={pcaQuery.data.cumVarRatio}
                retained={retained}
                varianceTarget={varianceTarget}
              />
            </div>

            {/* Retention slider */}
            <div className="mt-4 flex flex-wrap items-end gap-x-8 gap-y-3 border-t border-border pt-4">
              <div className="min-w-64 flex-1">
                <div className="flex items-baseline justify-between">
                  <label className="text-sm font-medium">
                    PCs to retain
                    <span className="ml-1 text-xs font-normal text-muted-foreground">
                      (default: {PCT(varianceTarget)} of variance)
                    </span>
                  </label>
                  <span className="text-sm tabular-nums text-muted-foreground">
                    {retained} of {nComponents}
                  </span>
                </div>
                <Slider
                  className="mt-3"
                  min={1}
                  max={nComponents}
                  step={1}
                  value={[retained]}
                  onValueChange={(v) => setRetained(v[0])}
                />
              </div>
              <div className="tabular-nums">
                <span className="text-2xl font-semibold">
                  {cumAtRetained != null ? PCT(cumAtRetained) : "—"}
                </span>
                <span className="ml-1.5 text-xs text-muted-foreground">
                  cumulative variance
                </span>
              </div>
            </div>
            {retainedOverride != null &&
              retainedOverride !== settingsQuery.data?.nComponentsRetained && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Re-run PCA to save {retained} as the retained count for Stage 8.
                </p>
              )}
          </div>

          {/* Loadings */}
          <LoadingsHeatmap
            loadings={pcaQuery.data.loadings}
            featureNames={pcaQuery.data.featureNames}
            shown={retained}
          />
        </>
      ) : pcaQuery.isError ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          Couldn’t load the PCA result. Try re-running PCA.
        </div>
      ) : null}
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

function PcaSkeleton() {
  return (
    <div className="flex h-full flex-col gap-4">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-72 w-full" />
      <Skeleton className="h-12 w-full" />
    </div>
  )
}
