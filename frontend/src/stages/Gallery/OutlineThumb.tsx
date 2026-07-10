import { useMemo } from "react"
import { HandIcon, SparklesIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { OutlineSvg, outlineShape } from "@/components/OutlineSvg"
import type { MaskEntry, PhotoRecord } from "@/types/domain"

interface OutlineThumbProps {
  record: PhotoRecord
  mask: MaskEntry
}

/**
 * One specimen's outline, shape-only, on a neutral card (ROADMAP Phase 7 / Stage 5).
 *
 * Unlike Stage 4's MaskThumb — which overlays the outline on the standardized photo —
 * the gallery shows JUST the closed polygon: this is the "compare shapes across
 * specimens at a glance" view (a long-narrow blob where you expected a wide V means
 * SAM grabbed the wrong thing). Because there is no image, the thumbnail is pure SVG
 * (no image fetch, no cache) — inherently fast even for a large series. The shape is
 * sampled + self-framed by the shared {@link outlineShape} helper. Read-only.
 */
export function OutlineThumb({ record, mask }: OutlineThumbProps) {
  const anchorPath = mask.anchorPath
  const shape = useMemo(() => outlineShape(anchorPath), [anchorPath])

  const auto = mask.source === "auto"

  return (
    <div
      title={record.filename}
      className="relative flex w-40 shrink-0 flex-col overflow-hidden rounded-lg border border-border bg-card text-left"
    >
      <div className="relative flex aspect-square items-center justify-center overflow-hidden bg-muted/40">
        {shape ? (
          <OutlineSvg
            points={shape.points}
            viewBox={shape.viewBox}
            className="h-full w-full p-2 text-primary"
          />
        ) : (
          <span className="text-[11px] text-muted-foreground">no outline</span>
        )}
        <span
          className={cn(
            "absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium",
            auto ? "bg-accent text-accent-foreground" : "bg-success/85 text-white",
          )}
        >
          {auto ? <SparklesIcon className="size-2.5" /> : <HandIcon className="size-2.5" />}
          {auto ? "auto" : "manual"}
        </span>
      </div>
      <div className="flex items-center justify-between gap-1 px-2 py-1.5">
        <span className="truncate text-xs font-medium" title={record.specimenId}>
          {record.specimenId}
        </span>
        <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">
          {anchorPath?.length ?? 0} pts
        </span>
      </div>
    </div>
  )
}
