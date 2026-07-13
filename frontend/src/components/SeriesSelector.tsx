import { useEffect } from "react"
import { Plus } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { NewSeriesDialog } from "@/components/NewSeriesDialog"
import { DeleteSeriesButton } from "@/components/DeleteSeriesButton"
import { useSeriesList } from "@/api/hooks"
import { useActiveSeriesStore } from "@/state/useActiveSeriesStore"

/**
 * Header dropdown of every discovered series. Writes the choice to the active-
 * series store (persisted). On first load, if nothing is active yet — or the
 * persisted key no longer exists — it defaults to the first series so the shell
 * always has a valid context.
 */
export function SeriesSelector() {
  const { data: series, isLoading, isError } = useSeriesList()
  const activeSeriesKey = useActiveSeriesStore((s) => s.activeSeriesKey)
  const setActiveSeriesKey = useActiveSeriesStore((s) => s.setActiveSeriesKey)

  // Keep the active key valid: adopt the first series when unset or stale.
  useEffect(() => {
    if (!series || series.length === 0) return
    const stillValid = series.some((s) => s.key === activeSeriesKey)
    if (!stillValid) setActiveSeriesKey(series[0].key)
  }, [series, activeSeriesKey, setActiveSeriesKey])

  if (isLoading) {
    return <Skeleton className="h-9 w-56" />
  }

  if (isError || !series || series.length === 0) {
    // No series to pick — the EmptyState screen carries the real messaging;
    // here we just show a disabled, inert control so the header stays stable.
    return (
      <Select disabled>
        <SelectTrigger className="w-56">
          <SelectValue placeholder="No series available" />
        </SelectTrigger>
      </Select>
    )
  }

  const activeSeries = series.find((s) => s.key === activeSeriesKey)

  return (
    <div className="flex items-center gap-2">
      <Select
        value={activeSeriesKey ?? undefined}
        onValueChange={setActiveSeriesKey}
      >
        <SelectTrigger className="w-56" aria-label="Active series">
          <SelectValue placeholder="Select a series…" />
        </SelectTrigger>
        <SelectContent>
          {series.map((s) => (
            <SelectItem key={s.key} value={s.key}>
              {s.displayName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <NewSeriesDialog
        trigger={
          <Button variant="outline" size="icon" aria-label="New series" title="New series">
            <Plus className="size-4" />
          </Button>
        }
      />
      {activeSeries && (
        <DeleteSeriesButton
          seriesKey={activeSeries.key}
          displayName={activeSeries.displayName}
        />
      )}
    </div>
  )
}
