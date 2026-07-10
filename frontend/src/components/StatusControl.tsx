import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"
import type { CurationStatus } from "@/types/domain"

interface StatusControlProps {
  value: CurationStatus
  onChange: (status: CurationStatus) => void
  disabled?: boolean
}

/**
 * Segmented Unreviewed / Accept / Reject control for one photo (a shadcn
 * toggle-group, `type="single"`). The active segment carries the matching
 * semantic status colour (warning / success / destructive) from the design
 * tokens. Re-clicking the active segment is a no-op (Radix emits `""`), so a
 * photo can never fall back to no status once set.
 */
const OPTIONS: { value: CurationStatus; label: string; activeClass: string }[] = [
  {
    value: "unreviewed",
    label: "Unreviewed",
    activeClass:
      "data-[state=on]:bg-warning data-[state=on]:text-warning-foreground",
  },
  {
    value: "accepted",
    label: "Accept",
    activeClass:
      "data-[state=on]:bg-success data-[state=on]:text-success-foreground",
  },
  {
    value: "rejected",
    label: "Reject",
    activeClass:
      "data-[state=on]:bg-destructive data-[state=on]:text-destructive-foreground",
  },
]

export function StatusControl({ value, onChange, disabled }: StatusControlProps) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next) onChange(next as CurationStatus)
      }}
      className="w-full"
      aria-label="Review status"
    >
      {OPTIONS.map((opt) => (
        <ToggleGroupItem
          key={opt.value}
          value={opt.value}
          className={cn("flex-1 text-xs", opt.activeClass)}
        >
          {opt.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
