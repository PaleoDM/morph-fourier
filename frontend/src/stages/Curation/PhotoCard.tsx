import { useState } from "react"
import { StarIcon } from "lucide-react"

import { ReasonCombobox } from "@/components/ReasonCombobox"
import { StatusControl } from "@/components/StatusControl"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import type { DecisionInput } from "@/api/curation"
import type { CurationStatus, PhotoDecision, PhotoRecord } from "@/types/domain"

const DEFAULT_DECISION: PhotoDecision = {
  status: "unreviewed",
  rejectionReason: null,
  isCanonical: false,
  notes: "",
}

interface PhotoCardProps {
  record: PhotoRecord
  seriesKey: string
  decision: PhotoDecision | undefined
  onSave: (recordKey: string, decision: DecisionInput) => void
}

/**
 * One source photo with its full decision controls: status segmented control,
 * a reject-reason combobox (only when rejected — and required), a "canonical"
 * toggle (enabled only when accepted; the backend enforces one per specimen),
 * and a notes field. Every control writes the whole decision through `onSave`;
 * the parent runs the optimistic mutation.
 */
export function PhotoCard({ record, seriesKey, decision, onSave }: PhotoCardProps) {
  const current = decision ?? DEFAULT_DECISION
  const [notes, setNotes] = useState(current.notes)

  const save = (patch: Partial<PhotoDecision>) => {
    onSave(record.recordKey, { ...current, notes, ...patch })
  }

  const handleStatus = (status: CurationStatus) => {
    // Leaving "accepted" drops canonical; leaving "rejected" clears the reason.
    save({
      status,
      isCanonical: status === "accepted" ? current.isCanonical : false,
      rejectionReason: status === "rejected" ? current.rejectionReason : null,
    })
  }

  const canonicalEnabled = current.status === "accepted"
  const rejected = current.status === "rejected"

  return (
    <div className="flex w-72 shrink-0 flex-col overflow-hidden rounded-lg border border-border bg-card">
      {/* Photo (CSS-downscaled; a thumbnail endpoint is a later perf pass). */}
      <div className="relative flex aspect-[4/3] items-center justify-center bg-muted">
        <img
          src={`/photos/${encodeURIComponent(seriesKey)}/${encodeURIComponent(record.filename)}`}
          alt={record.filename}
          loading="lazy"
          className="max-h-full max-w-full object-contain"
        />
        {current.isCanonical && (
          <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-md bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground">
            <StarIcon className="size-3 fill-current" />
            Canonical
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-3 p-3">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate font-mono text-xs text-muted-foreground" title={record.filename}>
            {record.filename}
          </span>
          <span className="shrink-0 text-[11px] text-muted-foreground">#{record.photoIndex}</span>
        </div>

        <StatusControl value={current.status} onChange={handleStatus} />

        {rejected && (
          <ReasonCombobox
            value={current.rejectionReason}
            onChange={(reason) => save({ status: "rejected", rejectionReason: reason })}
            required={!current.rejectionReason}
          />
        )}

        <Button
          type="button"
          variant={current.isCanonical ? "default" : "outline"}
          size="sm"
          disabled={!canonicalEnabled}
          onClick={() => save({ isCanonical: !current.isCanonical })}
          className={cn("w-full text-xs", !canonicalEnabled && "opacity-60")}
          title={
            canonicalEnabled
              ? "Mark this photo as the specimen's canonical view"
              : "Only an accepted photo can be canonical"
          }
        >
          <StarIcon className={cn("size-3.5", current.isCanonical && "fill-current")} />
          {current.isCanonical ? "Canonical" : "Mark canonical"}
        </Button>

        <Textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => {
            if (notes !== current.notes) save({})
          }}
          placeholder="Notes…"
          className="min-h-16 resize-none text-xs"
        />
      </div>
    </div>
  )
}
