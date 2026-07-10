import { useMemo, useState } from "react"
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"

import { OutlineSvg } from "@/components/OutlineSvg"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { sampleClosedCatmullRom } from "@/konva/catmullRom"
import { useReconstruct } from "@/api/efa"
import type { AnchorDir, MaskEntry, PhotoRecord, Point } from "@/types/domain"

const TOOLTIP_STYLE = {
  background: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--popover-foreground)",
  fontSize: 12,
  padding: "6px 10px",
} as const

const PAD_FRAC = 0.06

/** Frame a point set to its own padded bounding box → { points, viewBox } for OutlineSvg. */
function frame(pts: Point[]): { points: string; viewBox: string } | null {
  if (pts.length < 3) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of pts) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  const w = maxX - minX
  const h = maxY - minY
  if (!(w > 0) || !(h > 0)) return null
  const pad = Math.max(w, h) * PAD_FRAC
  const points = pts.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ")
  const viewBox = `${minX - pad} ${minY - pad} ${w + 2 * pad} ${h + 2 * pad}`
  return { points, viewBox }
}

interface SpecimenInspectorProps {
  seriesKey: string
  /** Canonicals that have a saved outline (anchorPath), in record order. */
  records: PhotoRecord[]
  masks: Record<string, MaskEntry>
  harmonics: number
  normalize: boolean
  anchor: AnchorDir
}

/**
 * Stage 6 inspector — pick a specimen and compare its saved outline against the
 * EFA reconstruction at the current harmonics/normalize, alongside the per-harmonic
 * power spectrum. The two shapes are each framed to their own bbox (not overlaid):
 * with normalization on, the reconstruction sits in a canonical pose, so this is a
 * shape-fidelity check ("does N harmonics capture the form?"), not a pixel overlay.
 */
export function SpecimenInspector({
  seriesKey,
  records,
  masks,
  harmonics,
  normalize,
  anchor,
}: SpecimenInspectorProps) {
  const [selected, setSelected] = useState<string>(records[0]?.recordKey ?? "")
  // If the selection fell out of the ready set (e.g. re-mask), fall back to first.
  const activeKey = records.some((r) => r.recordKey === selected)
    ? selected
    : (records[0]?.recordKey ?? "")

  const recon = useReconstruct(seriesKey, activeKey || null, harmonics, normalize, anchor)

  const original = useMemo(() => {
    const anchors = masks[activeKey]?.anchorPath
    if (!anchors || anchors.length < 3) return null
    return frame(sampleClosedCatmullRom(anchors))
  }, [masks, activeKey])

  const reconstructed = useMemo(
    () => (recon.data ? frame(recon.data.outline) : null),
    [recon.data],
  )

  const spectrum = useMemo(
    () =>
      recon.data?.powerSpectrum?.map((p, i) => ({ harmonic: i + 1, power: p })) ??
      [],
    [recon.data],
  )

  if (records.length === 0) return null

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-medium">Specimen inspector</h3>
        <Select value={activeKey} onValueChange={setSelected}>
          <SelectTrigger className="h-8 w-56 text-sm">
            <SelectValue placeholder="Pick a specimen" />
          </SelectTrigger>
          <SelectContent>
            {records.map((r) => (
              <SelectItem key={r.recordKey} value={r.recordKey}>
                {r.specimenId}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {/* Original */}
        <figure className="flex flex-col">
          <div className="flex aspect-square items-center justify-center rounded-md border border-border bg-muted/40 text-primary">
            {original ? (
              <OutlineSvg
                points={original.points}
                viewBox={original.viewBox}
                className="h-full w-full p-3"
              />
            ) : (
              <span className="text-xs text-muted-foreground">no outline</span>
            )}
          </div>
          <figcaption className="mt-1.5 text-center text-xs text-muted-foreground">
            Original outline
          </figcaption>
        </figure>

        {/* Reconstruction */}
        <figure className="flex flex-col">
          <div className="flex aspect-square items-center justify-center rounded-md border border-border bg-muted/40 text-accent-foreground">
            {recon.isLoading ? (
              <Skeleton className="size-full" />
            ) : recon.isError ? (
              <span className="px-2 text-center text-xs text-destructive">
                Couldn’t reconstruct
              </span>
            ) : reconstructed ? (
              <OutlineSvg
                points={reconstructed.points}
                viewBox={reconstructed.viewBox}
                className="h-full w-full p-3"
              />
            ) : (
              <span className="text-xs text-muted-foreground">—</span>
            )}
          </div>
          <figcaption className="mt-1.5 text-center text-xs text-muted-foreground tabular-nums">
            Reconstruction · {harmonics} harmonic{harmonics === 1 ? "" : "s"}
            {normalize ? " · normalized" : ""}
          </figcaption>
        </figure>

        {/* Power spectrum */}
        <figure className="flex flex-col">
          <div className="flex aspect-square items-center justify-center rounded-md border border-border bg-muted/40 p-1">
            {recon.isLoading ? (
              <Skeleton className="size-full" />
            ) : spectrum.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={spectrum} margin={{ top: 6, right: 6, bottom: 0, left: -14 }}>
                  <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="harmonic"
                    tick={{ fill: "var(--muted-foreground)", fontSize: 10 }}
                    tickLine={{ stroke: "var(--border)" }}
                    axisLine={{ stroke: "var(--border)" }}
                    interval={Math.max(0, Math.floor(spectrum.length / 8))}
                  />
                  <YAxis
                    tick={{ fill: "var(--muted-foreground)", fontSize: 10 }}
                    tickLine={{ stroke: "var(--border)" }}
                    axisLine={{ stroke: "var(--border)" }}
                    width={40}
                  />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    formatter={(v) => [Number(v).toExponential(2), "power"]}
                    labelFormatter={(h) => `harmonic ${h}`}
                    cursor={{ fill: "var(--muted)", opacity: 0.4 }}
                  />
                  <Bar dataKey="power" fill="var(--primary)" isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <span className="text-xs text-muted-foreground">—</span>
            )}
          </div>
          <figcaption className="mt-1.5 text-center text-xs text-muted-foreground">
            Power spectrum
          </figcaption>
        </figure>
      </div>
    </div>
  )
}
