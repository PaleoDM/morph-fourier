import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { STAGES, type StageId } from "@/types/domain"
import { useActiveSeriesStatus } from "@/api/hooks"
import { useActiveSeriesStore } from "@/state/useActiveSeriesStore"

interface StageNavProps {
  activeStage: StageId
  onSelectStage: (stage: StageId) => void
}

/**
 * Left rail: the eight pipeline stages in order. Each tab shows a completion
 * badge (readyCount / totalCanonicals) pulled from the active series' status.
 * Selecting a tab switches the main content region (Phase 2 shows placeholders;
 * Phases 3–9 mount the real stage screens here).
 */
export function StageNav({ activeStage, onSelectStage }: StageNavProps) {
  const activeSeriesKey = useActiveSeriesStore((s) => s.activeSeriesKey)
  const { data: statuses, isLoading } = useActiveSeriesStatus()

  return (
    <nav
      aria-label="Pipeline stages"
      className="flex w-[220px] shrink-0 flex-col gap-1 border-r border-border bg-card/40 p-3"
    >
      {STAGES.map((stage) => {
        const status = statuses?.[stage.id]
        // Prime has no aggregate-status entry (its progress is the exemplar count,
        // shown in-stage), so it carries no rail badge once statuses have loaded.
        const inStatusMap = statuses ? stage.id in statuses : true
        const isActive = stage.id === activeStage
        return (
          <button
            key={stage.id}
            type="button"
            onClick={() => onSelectStage(stage.id)}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "group flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              isActive
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-accent-foreground",
            )}
          >
            <span
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] tabular-nums",
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {stage.index}
            </span>
            <span className="flex-1 truncate">{stage.label}</span>
            <StageBadge
              hasSeries={activeSeriesKey != null && inStatusMap}
              isLoading={isLoading}
              ready={status?.readyCount ?? 0}
            />
          </button>
        )
      })}
    </nav>
  )
}

function StageBadge({
  hasSeries,
  isLoading,
  ready,
}: {
  hasSeries: boolean
  isLoading: boolean
  ready: number
}) {
  if (!hasSeries) return null
  return (
    <Badge variant="muted" className="tabular-nums">
      {isLoading ? "…" : ready}
    </Badge>
  )
}
