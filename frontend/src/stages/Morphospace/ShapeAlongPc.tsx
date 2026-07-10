import { useMemo } from "react"

import { OutlineSvg } from "@/components/OutlineSvg"
import { Skeleton } from "@/components/ui/skeleton"
import { usePcaReconstruct } from "@/api/taxonomy"
import type { PcaResult } from "@/types/domain"
import { frameOutline } from "./types"

/** Standard-deviation multipliers to walk along a PC (mean at the centre). */
const SIGMAS = [-2, -1, 0, 1, 2] as const

interface ShapeAlongPcProps {
  seriesKey: string
  pca: PcaResult
  xPc: number
  yPc: number
}

/**
 * Stage 8 — the "what does this PC mean as a shape?" interpreter (ROADMAP Phase 9
 * step 3). For each of the chosen X and Y axes, we back-project the mean shape moved
 * −2σ … +2σ along that PC (all other PCs held at 0) and draw the five outlines as a
 * small-multiples strip. σ per PC is the standard deviation of the specimens' scores
 * on it (= √eigenvalue), so the walk spans the real spread of the data.
 */
export function ShapeAlongPc({ seriesKey, pca, xPc, yPc }: ShapeAlongPcProps) {
  // σ per PC = sample std of the score column (scores are mean-centred, so mean ≈ 0).
  const sigma = useMemo(() => {
    const n = pca.scores.length
    return (pc: number) => {
      if (n < 2) return 0
      let ss = 0
      for (const row of pca.scores) {
        const v = row[pc - 1] ?? 0
        ss += v * v
      }
      return Math.sqrt(ss / (n - 1))
    }
  }, [pca.scores])

  // One strip per distinct axis (X and Y usually differ; collapse if the user set them equal).
  const axes = xPc === yPc ? [xPc] : [xPc, yPc]

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-medium">Shape along each PC</h3>
      <p className="mt-0.5 text-xs text-muted-foreground">
        The mean shape reconstructed at −2σ to +2σ along each axis (all other PCs held
        at the mean). This is what moving along the axis <em>does</em> to the outline.
      </p>
      <div className="mt-3 flex flex-col gap-4">
        {axes.map((pc) => (
          <Strip key={pc} seriesKey={seriesKey} pc={pc} sigma={sigma(pc)} />
        ))}
      </div>
    </div>
  )
}

function Strip({
  seriesKey,
  pc,
  sigma,
}: {
  seriesKey: string
  pc: number
  sigma: number
}) {
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium text-muted-foreground">PC{pc}</div>
      <div className="flex flex-wrap gap-2">
        {SIGMAS.map((mult) => (
          <StripCell
            key={mult}
            seriesKey={seriesKey}
            pc={pc}
            mult={mult}
            value={mult * sigma}
          />
        ))}
      </div>
    </div>
  )
}

function StripCell({
  seriesKey,
  pc,
  mult,
  value,
}: {
  seriesKey: string
  pc: number
  mult: number
  value: number
}) {
  const query = usePcaReconstruct(seriesKey, { [String(pc)]: value })
  const shape = useMemo(
    () => (query.data ? frameOutline(query.data.outline) : null),
    [query.data],
  )

  const caption = mult === 0 ? "mean" : `${mult > 0 ? "+" : ""}${mult}σ`

  return (
    <div className="flex w-28 shrink-0 flex-col items-center">
      <div className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-lg border border-border bg-muted/40">
        {query.isLoading ? (
          <Skeleton className="size-20 rounded-md" />
        ) : shape ? (
          <OutlineSvg
            points={shape.points}
            viewBox={shape.viewBox}
            className={
              mult === 0 ? "h-full w-full p-2 text-foreground" : "h-full w-full p-2 text-primary"
            }
          />
        ) : (
          <span className="text-[11px] text-muted-foreground">—</span>
        )}
      </div>
      <span className="mt-1 text-[11px] tabular-nums text-muted-foreground">{caption}</span>
    </div>
  )
}
