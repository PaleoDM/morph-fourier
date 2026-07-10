import { useMemo } from "react"
import { PencilIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { OutlineSvg, outlineShape } from "@/components/OutlineSvg"
import type { AutoResult, MaskEntry, PhotoRecord } from "@/types/domain"
import { reviewStatus, type ReviewTone } from "./status"

interface ReviewThumbProps {
  record: PhotoRecord
  mask: MaskEntry | undefined
  result: AutoResult | undefined
  onRefine: (record: PhotoRecord) => void
}

const TONE_CHIP: Record<ReviewTone, string> = {
  success: "bg-success/85 text-white",
  auto: "bg-accent text-accent-foreground",
  warning: "bg-warning text-white",
  destructive: "bg-destructive text-white",
  muted: "bg-muted text-muted-foreground",
}

const TONE_RING: Record<ReviewTone, string> = {
  success: "border-border",
  auto: "border-border",
  warning: "border-warning/60",
  destructive: "border-destructive/60",
  muted: "border-border",
}

/**
 * One specimen in the Review grid: its shape-only outline (from the stored anchor path,
 * self-framed), a status/flag chip, and — when flagged — the explanation for why. The
 * whole card is a button that opens the refine wizard. Flagged specimens get a coloured
 * border so they read as needing attention even before the flagged-first sort.
 */
export function ReviewThumb({ record, mask, result, onRefine }: ReviewThumbProps) {
  const shape = useMemo(() => outlineShape(mask?.anchorPath), [mask])
  const status = reviewStatus(result, !!mask)

  return (
    <button
      type="button"
      onClick={() => onRefine(record)}
      title={`Refine ${record.specimenId}`}
      className={cn(
        "group relative flex w-44 flex-col overflow-hidden rounded-lg border bg-card text-left transition-colors hover:border-primary/60",
        TONE_RING[status.tone],
      )}
    >
      <div className="relative flex aspect-square items-center justify-center overflow-hidden bg-muted/40">
        {shape ? (
          <OutlineSvg
            points={shape.points}
            viewBox={shape.viewBox}
            className="h-full w-full p-2 text-primary"
          />
        ) : (
          <span className="px-3 text-center text-[11px] text-muted-foreground">
            No outline yet — refine to draw one
          </span>
        )}

        <span
          className={cn(
            "absolute left-1.5 top-1.5 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium",
            TONE_CHIP[status.tone],
          )}
        >
          {status.label}
        </span>

        {/* Hover affordance — the whole card refines. */}
        <span className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 bg-primary/90 py-1 text-[11px] font-medium text-primary-foreground opacity-0 transition-opacity group-hover:opacity-100">
          <PencilIcon className="size-3" />
          Refine
        </span>
      </div>

      <div className="flex flex-col gap-0.5 p-2">
        <span className="truncate text-xs font-medium" title={record.specimenId}>
          {record.specimenId}
        </span>
        {status.detail ? (
          <span className="line-clamp-2 text-[11px] text-muted-foreground">{status.detail}</span>
        ) : (
          <span className="truncate text-[11px] text-muted-foreground" title={record.label}>
            {record.label}
          </span>
        )}
      </div>
    </button>
  )
}
