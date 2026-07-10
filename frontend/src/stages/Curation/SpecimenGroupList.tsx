import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { PhotoDecision } from "@/types/domain"
import {
  specimenState,
  type SpecimenGroup,
  type SpecimenState,
} from "./grouping"

const STATE_BADGE: Record<
  SpecimenState,
  { label: string; variant: "success" | "destructive" | "warning" | "muted" }
> = {
  canonical: { label: "Done", variant: "success" },
  rejected: { label: "Rejected", variant: "destructive" },
  "in-review": { label: "In review", variant: "warning" },
  new: { label: "New", variant: "muted" },
}

interface SpecimenGroupListProps {
  groups: SpecimenGroup[]
  photos: Record<string, PhotoDecision>
  selectedKey: string | null
  onSelect: (specimenKey: string) => void
}

/**
 * Left sidebar listing every specimen group with a per-group review badge.
 * Selecting one drives the main photo panel. Multi-photo specimens show their
 * photo count so it's obvious which specimens have siblings to compare.
 */
export function SpecimenGroupList({
  groups,
  photos,
  selectedKey,
  onSelect,
}: SpecimenGroupListProps) {
  return (
    <ul className="flex flex-col gap-1">
      {groups.map((group) => {
        const state = specimenState(group, photos)
        const badge = STATE_BADGE[state]
        const isActive = group.specimenKey === selectedKey
        return (
          <li key={group.specimenKey}>
            <button
              type="button"
              onClick={() => onSelect(group.specimenKey)}
              aria-current={isActive ? "true" : undefined}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                isActive
                  ? "bg-accent text-accent-foreground"
                  : "text-foreground hover:bg-accent/60",
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{group.specimenId}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {group.label}
                  {group.records.length > 1 && ` · ${group.records.length} photos`}
                </div>
              </div>
              <Badge variant={badge.variant} className="shrink-0 text-[10px]">
                {badge.label}
              </Badge>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
