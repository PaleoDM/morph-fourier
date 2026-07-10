import { useMemo, useState } from "react"
import { AlertTriangleIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useSeriesRecords, useCuration } from "@/api/curation"
import { useMask } from "@/api/mask"
import { useEfa, useCalibrate, useComputeEfa } from "@/api/efa"
import { useActiveSeriesStore } from "@/state/useActiveSeriesStore"
import { canonicalRecords } from "@/lib/canonicals"
import { DEFAULT_HARMONICS, MAX_HARMONICS, type AnchorDir } from "@/types/domain"

const ANCHORS: { value: AnchorDir; label: string }[] = [
  { value: "top", label: "Top" },
  { value: "bottom", label: "Bottom" },
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
]
import { CalibrationChart } from "./CalibrationChart"
import { SpecimenInspector } from "./SpecimenInspector"

/**
 * Stage 6 — Elliptic Fourier Analysis. Pick a harmonic count (with a Calibrate
 * assist that pools cumulative-power curves and recommends 95/99/99.9% counts),
 * choose whether to normalize (Kuhl & Giardina), compute the coefficient matrix,
 * and inspect any specimen's original-vs-reconstruction fidelity. Free-exploration
 * stage — no lock; carries `lastComputedAt`.
 */
export function EfaStage() {
  const seriesKey = useActiveSeriesStore((s) => s.activeSeriesKey)

  const recordsQuery = useSeriesRecords(seriesKey)
  const curationQuery = useCuration(seriesKey)
  const maskQuery = useMask(seriesKey)
  const efaQuery = useEfa(seriesKey)

  const calibrate = useCalibrate(seriesKey ?? "")
  const compute = useComputeEfa(seriesKey ?? "")

  // Effective settings: the user's override if they touched it, else the persisted
  // value, else the default — no mount effect needed to hydrate from the server.
  const [harmonicsOverride, setHarmonics] = useState<number | null>(null)
  const [normalizeOverride, setNormalize] = useState<boolean | null>(null)
  const [anchorOverride, setAnchor] = useState<AnchorDir | null>(null)
  const harmonics = harmonicsOverride ?? efaQuery.data?.harmonics ?? DEFAULT_HARMONICS
  const normalize = normalizeOverride ?? efaQuery.data?.normalize ?? true
  const anchor = anchorOverride ?? efaQuery.data?.anchor ?? "top"

  const canon = useMemo(
    () => canonicalRecords(recordsQuery.data?.records ?? [], curationQuery.data),
    [recordsQuery.data, curationQuery.data],
  )
  const masks = useMemo(() => maskQuery.data?.masks ?? {}, [maskQuery.data])
  // The working set for EFA = canonicals that actually have a saved outline.
  const ready = useMemo(
    () => canon.filter((r) => masks[r.recordKey]?.anchorPath != null),
    [canon, masks],
  )

  const isLoading =
    recordsQuery.isLoading ||
    curationQuery.isLoading ||
    maskQuery.isLoading ||
    efaQuery.isLoading
  const isError =
    recordsQuery.isError ||
    curationQuery.isError ||
    maskQuery.isError ||
    efaQuery.isError

  if (!seriesKey || isLoading) return <EfaSkeleton />

  // Distinguish a fetch failure from "no outlines yet" — otherwise a backend outage
  // reads as an empty dataset, which is misleading. Offer a retry, not a dead end.
  if (isError) {
    return (
      <StageMessage
        icon={<AlertTriangleIcon className="size-7" />}
        title="Couldn’t load EFA data"
        body="The records, curation, mask, or EFA-settings request failed. Make sure the backend is running, then retry."
        action={
          <Button
            variant="outline"
            onClick={() => {
              void recordsQuery.refetch()
              void curationQuery.refetch()
              void maskQuery.refetch()
              void efaQuery.refetch()
            }}
          >
            Retry
          </Button>
        }
      />
    )
  }

  if (ready.length === 0) {
    return (
      <StageMessage
        icon={<AlertTriangleIcon className="size-7" />}
        title="No outlines to analyze yet"
        body="EFA runs on the saved outlines from Stage 4. Mark specimens canonical, then Orient, Crop, and Mask at least a couple of them before computing."
      />
    )
  }

  const computed = efaQuery.data?.lastComputedAt ?? null

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      {/* Header */}
      <div>
        <p className="text-sm font-medium text-muted-foreground">Stage 6</p>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">EFA</h1>
          <span className="text-sm tabular-nums text-muted-foreground">
            {ready.length} outline{ready.length === 1 ? "" : "s"} ready
            {computed && (
              <>
                {" · "}
                {efaQuery.data?.nSpecimensComputed} computed at{" "}
                {efaQuery.data?.harmonics} harmonics
              </>
            )}
          </span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Fit elliptic Fourier descriptors to every outline. More harmonics capture
          finer detail; calibrate to find the smallest count that still captures the
          shape, then compute the coefficient matrix that feeds PCA.
        </p>
      </div>

      {/* Controls */}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-end gap-x-8 gap-y-4">
          <div className="min-w-64 flex-1">
            <div className="flex items-baseline justify-between">
              <label className="text-sm font-medium">Harmonics</label>
              <span className="text-sm tabular-nums text-muted-foreground">
                {harmonics}
              </span>
            </div>
            <Slider
              className="mt-3"
              min={2}
              max={MAX_HARMONICS}
              step={1}
              value={[harmonics]}
              onValueChange={(v) => setHarmonics(v[0])}
            />
          </div>

          <label className="flex items-center gap-2.5">
            <Switch
              checked={normalize}
              onCheckedChange={(c) => setNormalize(c)}
            />
            <span className="text-sm">
              Normalize
              <span className="ml-1 text-xs text-muted-foreground">
                (size &amp; start point; keeps your orientation)
              </span>
            </span>
          </label>

          {normalize && (
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Start at</span>
              <Select value={anchor} onValueChange={(v) => setAnchor(v as AnchorDir)}>
                <SelectTrigger className="h-8 w-[7.5rem]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ANCHORS.map((a) => (
                    <SelectItem key={a.value} value={a.value}>
                      {a.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          )}

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => calibrate.mutate()}
              disabled={calibrate.isPending}
            >
              {calibrate.isPending ? "Calibrating…" : "Calibrate"}
            </Button>
            <Button
              onClick={() => compute.mutate({ harmonics, normalize, anchor })}
              disabled={compute.isPending}
            >
              {compute.isPending ? "Computing…" : "Compute EFA"}
            </Button>
          </div>
        </div>
      </div>

      {/* Calibration result */}
      {calibrate.data && (
        <CalibrationChart
          result={calibrate.data}
          currentHarmonics={harmonics}
          onUseHarmonics={setHarmonics}
        />
      )}

      {/* Inspector — only meaningful once coefficients exist, but reconstruct works
          off the saved outline directly, so it's available as soon as outlines are. */}
      <SpecimenInspector
        seriesKey={seriesKey}
        records={ready}
        masks={masks}
        harmonics={harmonics}
        normalize={normalize}
        anchor={anchor}
      />
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

function EfaSkeleton() {
  return (
    <div className="flex h-full flex-col gap-4">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-56 w-full" />
    </div>
  )
}
