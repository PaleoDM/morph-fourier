import { CheckCircle2Icon, SparklesIcon, XIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { PhotoRecord } from "@/types/domain"

interface PrimeThumbProps {
  record: PhotoRecord
  seriesKey: string
  primed: boolean
  /** Nudged as the next diverse pick — highlighted so the user knows where to look. */
  suggested: boolean
  onPrime: (record: PhotoRecord) => void
  onUnprime: (recordKey: string) => void
}

/**
 * One canonical specimen in the Prime grid: its raw photo, id, and a Prime /
 * Re-prime action. A primed specimen wears a check badge; the diversity-nudge
 * suggestion gets a ring so the user can spot the recommended next pick.
 */
export function PrimeThumb({
  record,
  seriesKey,
  primed,
  suggested,
  onPrime,
  onUnprime,
}: PrimeThumbProps) {
  const src = `/photos/${encodeURIComponent(seriesKey)}/${encodeURIComponent(record.filename)}`

  return (
    <div
      className={cn(
        "group relative flex w-40 flex-col overflow-hidden rounded-lg border bg-card transition-colors",
        primed ? "border-success/60" : suggested ? "border-primary ring-2 ring-primary/40" : "border-border",
      )}
    >
      <div className="relative aspect-square w-full overflow-hidden bg-muted">
        <img
          src={src}
          alt={record.specimenId}
          loading="lazy"
          className="size-full object-cover"
        />
        {primed && (
          <Badge variant="success" className="absolute left-1.5 top-1.5 gap-1 px-1.5 py-0.5 text-[10px]">
            <CheckCircle2Icon className="size-3" />
            Primed
          </Badge>
        )}
        {!primed && suggested && (
          <Badge className="absolute left-1.5 top-1.5 gap-1 px-1.5 py-0.5 text-[10px]">
            <SparklesIcon className="size-3" />
            Suggested
          </Badge>
        )}
        {primed && (
          <button
            type="button"
            onClick={() => onUnprime(record.recordKey)}
            title="Un-prime this specimen"
            className="absolute right-1.5 top-1.5 flex size-6 items-center justify-center rounded-full bg-background/80 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
          >
            <XIcon className="size-3.5" />
          </button>
        )}
      </div>

      <div className="flex flex-col gap-1 p-2">
        <p className="truncate text-xs font-medium" title={record.specimenId}>
          {record.specimenId}
        </p>
        <p className="truncate text-[11px] text-muted-foreground" title={record.label}>
          {record.label}
        </p>
        <Button
          variant={primed ? "outline" : "default"}
          size="sm"
          className="mt-1 h-7 w-full text-xs"
          onClick={() => onPrime(record)}
        >
          {primed ? "Re-prime" : "Prime"}
        </Button>
      </div>
    </div>
  )
}
