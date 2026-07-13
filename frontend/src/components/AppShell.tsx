import { Suspense, lazy, useCallback, useEffect, useState } from "react"
import { KeyboardIcon } from "lucide-react"

import { Logo } from "@/components/Logo"
import { SeriesSelector } from "@/components/SeriesSelector"
import { StageNav } from "@/components/StageNav"
import { EmptyState } from "@/components/EmptyState"
import { ErrorState } from "@/components/ErrorState"
import { ErrorBoundary } from "@/components/ErrorBoundary"
import { ShortcutsHelp } from "@/components/ShortcutsHelp"
import { ThemeToggle } from "@/components/ThemeToggle"
import { Skeleton } from "@/components/ui/skeleton"
import { useSeriesList } from "@/api/hooks"
import { STAGES, STAGE_IDS, type StageId } from "@/types/domain"

// Every stage screen is code-split (React.lazy). This keeps the heavy per-stage
// dependencies out of the main bundle: the Konva editors (reused in the Prime/Review
// box-frame wizard), the Recharts charts (Efa/Pca), and — with the Morphospace stage's
// own inner lazy import — Plotly. The main chunk carries only the shell + whatever
// stage the user opens first, loaded behind the Suspense fallback below.
//
// The Phase-11 redesign replaced the manual Orient → Crop → Mask stages with the
// prime → automate → review flow; their Konva editors live on inside EditorWizard.
const CurationStage = lazyStage(() => import("@/stages/Curation/CurationStage"), "CurationStage")
const PrimeStage = lazyStage(() => import("@/stages/Prime/PrimeStage"), "PrimeStage")
const AutomateStage = lazyStage(() => import("@/stages/Automate/AutomateStage"), "AutomateStage")
const ReviewStage = lazyStage(() => import("@/stages/Review/ReviewStage"), "ReviewStage")
const GalleryStage = lazyStage(() => import("@/stages/Gallery/GalleryStage"), "GalleryStage")
const EfaStage = lazyStage(() => import("@/stages/Efa/EfaStage"), "EfaStage")
const PcaStage = lazyStage(() => import("@/stages/Pca/PcaStage"), "PcaStage")
const MorphospaceStage = lazyStage(() => import("@/stages/Morphospace/MorphospaceStage"), "MorphospaceStage")

/** React.lazy over a named export (the stages export named, not default). */
function lazyStage<K extends string>(
  loader: () => Promise<Record<K, React.ComponentType>>,
  name: K,
) {
  return lazy(async () => ({ default: (await loader())[name] }))
}

const STAGE_COMPONENTS: Record<StageId, React.ComponentType> = {
  curation: CurationStage,
  prime: PrimeStage,
  automate: AutomateStage,
  review: ReviewStage,
  gallery: GalleryStage,
  efa: EfaStage,
  pca: PcaStage,
  morphospace: MorphospaceStage,
}

/**
 * Top-level application layout (ROADMAP §5): a fixed header (app name + series
 * selector + theme toggle) over a two-column body (stage rail + main content).
 * The active stage screen mounts in the content region behind a Suspense (lazy
 * chunk load) and an ErrorBoundary (recoverable fallback on a render crash), both
 * reset when the stage changes so navigating away from a broken stage recovers.
 */
export function AppShell() {
  const [activeStage, setActiveStage] = useState<StageId>(STAGE_IDS[0])
  const [helpOpen, setHelpOpen] = useState(false)
  const {
    data: series,
    isLoading,
    isError,
    error,
    refetch,
    isFetching,
  } = useSeriesList()

  const hasSeries = !!series && series.length > 0

  useGlobalShortcuts({
    onStage: (index) => setActiveStage(STAGE_IDS[index - 1]),
    onHelp: () => setHelpOpen((v) => !v),
    enabled: hasSeries,
  })

  const ActiveStage = STAGE_COMPONENTS[activeStage]

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      {/* Header */}
      <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border px-4">
        <div className="flex items-center gap-2">
          <Logo className="h-7 w-auto" />
          <span className="text-base font-semibold tracking-tight">
            Morph-Fourier
          </span>
        </div>
        <div className="flex items-center gap-2">
          <SeriesSelector />
          <button
            type="button"
            onClick={() => setHelpOpen(true)}
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts (?)"
            className="flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <KeyboardIcon className="size-4" />
          </button>
          <ThemeToggle />
        </div>
      </header>

      {/* Body */}
      {isLoading ? (
        <ShellSkeleton />
      ) : isError ? (
        <div className="flex flex-1 overflow-hidden">
          <ErrorState
            message={error instanceof Error ? error.message : undefined}
            onRetry={() => void refetch()}
            isRetrying={isFetching}
          />
        </div>
      ) : !hasSeries ? (
        <div className="flex flex-1 overflow-hidden">
          <EmptyState />
        </div>
      ) : (
        <div className="flex flex-1 overflow-hidden">
          <StageNav activeStage={activeStage} onSelectStage={setActiveStage} />
          <main className="flex-1 overflow-hidden p-8">
            {/* Reset both boundaries when the stage changes: a fresh Suspense for the
                new chunk, and a cleared ErrorBoundary so a prior crash doesn't stick. */}
            <ErrorBoundary resetKeys={[activeStage]}>
              <Suspense fallback={<StageSkeleton />}>
                <ActiveStage />
              </Suspense>
            </ErrorBoundary>
          </main>
        </div>
      )}

      {/* Footer — shown on every stage */}
      <footer className="shrink-0 border-t border-border px-4 py-2 text-center text-xs text-muted-foreground">
        Carlos Mauricio Peredo, 2026 &nbsp;|&nbsp; Funded by Vivitec AI
      </footer>

      <ShortcutsHelp open={helpOpen} onOpenChange={setHelpOpen} />
    </div>
  )
}

/**
 * Global keyboard shortcuts (Phase 10): number keys 1–8 jump to a stage; `?` opens
 * the shortcut help. Both are suppressed while the user is typing in a form field
 * or a modifier is held, so they never fight real input. Esc is left to the native
 * Radix layer (it closes the help dialog and any open menu/popover on its own).
 */
function useGlobalShortcuts({
  onStage,
  onHelp,
  enabled,
}: {
  onStage: (index: number) => void
  onHelp: () => void
  enabled: boolean
}) {
  const handler = useCallback(
    (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) {
        return
      }

      if (e.key === "?") {
        e.preventDefault()
        onHelp()
        return
      }

      if (!enabled) return
      // Digits 1–8 map to the eight stages (guarding against '9'/'0').
      const n = Number(e.key)
      if (Number.isInteger(n) && n >= 1 && n <= STAGE_IDS.length) {
        e.preventDefault()
        onStage(n)
      }
    },
    [onStage, onHelp, enabled],
  )

  useEffect(() => {
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [handler])
}

/** Loading state for the whole body while series discovery is in flight. */
function ShellSkeleton() {
  return (
    <div className="flex flex-1 overflow-hidden">
      <div className="flex w-[220px] shrink-0 flex-col gap-1 border-r border-border p-3">
        {STAGES.map((stage) => (
          <Skeleton key={stage.id} className="h-9 w-full" />
        ))}
      </div>
      <div className="flex-1 p-8">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="mt-4 h-40 w-full max-w-2xl" />
      </div>
    </div>
  )
}

/** Fallback while a stage's lazy chunk loads (bundle diet code-split). */
function StageSkeleton() {
  return (
    <div className="flex h-full flex-col gap-4">
      <Skeleton className="h-8 w-44" />
      <Skeleton className="h-24 w-full max-w-2xl" />
      <Skeleton className="h-64 w-full" />
    </div>
  )
}
