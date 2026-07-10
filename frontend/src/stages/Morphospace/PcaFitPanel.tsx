import { useMemo } from "react"
import { FilterIcon, RotateCcwIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import type { TaxonomyColumn, TaxonomyState } from "@/types/domain"

import type { SpecimenRow } from "./MorphospaceStage"

const UNLABELED = "— unlabeled —"

interface PcaFitPanelProps {
  specimens: SpecimenRow[]
  assignments: TaxonomyState["assignments"]
  columns: TaxonomyColumn[]
  colorBy: string
  excludedSpecimens: string[]
  onApply: (excludedIds: string[]) => void
  isPending: boolean
}

/**
 * Choose which specimens feed the PCA fit, one taxonomic group at a time. Excluding a
 * group refits the PCA on the remaining specimens, so a dominant group can be set aside
 * and the rest define their own axes (rather than merely being hidden in a space the
 * excluded group still shapes). Groups come from the active colour-by categorical tag.
 */
export function PcaFitPanel({
  specimens,
  assignments,
  columns,
  colorBy,
  excludedSpecimens,
  onApply,
  isPending,
}: PcaFitPanelProps) {
  const activeCol = columns.find((c) => c.name === colorBy) ?? null
  const isCategorical = activeCol?.type === "categorical"

  const excluded = useMemo(() => new Set(excludedSpecimens), [excludedSpecimens])

  const groups = useMemo(() => {
    if (!isCategorical) return []
    const m = new Map<string, string[]>()
    for (const s of specimens) {
      const raw = assignments[s.idSafe]?.[colorBy]
      const key = raw === null || raw === undefined || raw === "" ? UNLABELED : String(raw)
      const arr = m.get(key)
      if (arr) arr.push(s.idSafe)
      else m.set(key, [s.idSafe])
    }
    return Array.from(m.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([label, ids]) => ({ label, ids }))
  }, [specimens, assignments, colorBy, isCategorical])

  const includedCount = specimens.filter((s) => !excluded.has(s.idSafe)).length
  const anyExcluded = specimens.some((s) => excluded.has(s.idSafe))

  function toggleGroup(ids: string[], include: boolean) {
    const next = new Set(excluded)
    if (include) ids.forEach((id) => next.delete(id))
    else ids.forEach((id) => next.add(id))
    onApply(Array.from(next))
  }

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <FilterIcon className="size-4 text-muted-foreground" />
          PCA fit
          <Badge variant="secondary" className="font-normal">
            {includedCount} of {specimens.length} specimens
          </Badge>
        </div>
        {anyExcluded && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={() => onApply([])}
            disabled={isPending}
          >
            <RotateCcwIcon className="size-3.5" />
            Reset (fit on all)
          </Button>
        )}
      </div>

      {!isCategorical ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Colour the scatter by a categorical tag (the control above the plot) to switch whole
          groups in or out of the PCA fit. Excluding a group refits the analysis on the rest.
        </p>
      ) : (
        <>
          <p className="mt-2 text-xs text-muted-foreground">
            Toggle a group off to drop it from the fit and recompute the axes on what remains.
          </p>
          <ul className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
            {groups.map(({ label, ids }) => {
              const included = ids.some((id) => !excluded.has(id))
              return (
                <li
                  key={label}
                  className="flex items-center justify-between gap-3 py-1"
                >
                  <span
                    className={
                      "flex-1 truncate text-sm " +
                      (included ? "" : "text-muted-foreground line-through")
                    }
                    title={label}
                  >
                    {label}
                    <span className="ml-1.5 text-xs text-muted-foreground">({ids.length})</span>
                  </span>
                  <Switch
                    checked={included}
                    disabled={isPending}
                    onCheckedChange={(checked) => toggleGroup(ids, checked)}
                    aria-label={`Include ${label} in the PCA fit`}
                  />
                </li>
              )
            })}
          </ul>
        </>
      )}
    </div>
  )
}
