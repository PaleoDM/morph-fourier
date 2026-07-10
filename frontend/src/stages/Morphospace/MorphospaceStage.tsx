import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AlertTriangleIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useCuration, useSeriesRecords } from "@/api/curation"
import { usePca, usePcaSettings, useRunPca } from "@/api/pca"
import { useSaveTaxonomy, useTaxonomy } from "@/api/taxonomy"
import { useActiveSeriesStore } from "@/state/useActiveSeriesStore"
import { canonicalRecords } from "@/lib/canonicals"
import type { TaxonomyState } from "@/types/domain"
import { PcaFitPanel } from "./PcaFitPanel"
import { TaxonomyEditor } from "./TaxonomyEditor"
import { ShapeAlongPc } from "./ShapeAlongPc"
import type { PlotSpecimen } from "./types"

// Plotly is a large dependency — keep it out of the main bundle. React.lazy pushes
// MorphospacePlot (and its Plotly import) into its own chunk, loaded on demand
// behind the Suspense fallback below (ROADMAP Phase 9 bundle-watch).
const MorphospacePlot = lazy(() => import("./MorphospacePlot"))

const SAVE_DEBOUNCE_MS = 600

/** One canonical specimen (deduped by the join key) — the taxonomy table's row set. */
export interface SpecimenRow {
  idSafe: string // specimenIdSafe — the join key with PCA scores
  specimenId: string
  label: string
}

/**
 * Stage 8 — Taxonomy + Morphospace. The payoff view: tag specimens with metadata,
 * then read shape variation off an interactive PC scatter you can colour by any tag,
 * with shape-along-PC reconstructions that say what each axis *means* as a shape.
 *
 * Free-exploration stage (no lock). Gated on PCA having been run for the series —
 * the scatter plots specimens at their PC scores, so without a fit there's nothing
 * to place. Taxonomy edits auto-save (debounced) to taxonomy.json.
 */
export function MorphospaceStage() {
  const seriesKey = useActiveSeriesStore((s) => s.activeSeriesKey)

  const recordsQuery = useSeriesRecords(seriesKey)
  const curationQuery = useCuration(seriesKey)
  const settingsQuery = usePcaSettings(seriesKey)
  const hasRun = settingsQuery.data?.lastComputedAt != null
  const pcaQuery = usePca(seriesKey, hasRun)
  const taxonomyQuery = useTaxonomy(seriesKey)
  const runPca = useRunPca(seriesKey ?? "∅")
  const save = useSaveTaxonomy(seriesKey ?? "")

  // Row set for the editor: one row per canonical, deduped by the join key.
  const specimens = useMemo<SpecimenRow[]>(() => {
    const canon = canonicalRecords(recordsQuery.data?.records ?? [], curationQuery.data)
    const seen = new Set<string>()
    const rows: SpecimenRow[] = []
    for (const r of canon) {
      if (seen.has(r.specimenIdSafe)) continue
      seen.add(r.specimenIdSafe)
      rows.push({ idSafe: r.specimenIdSafe, specimenId: r.specimenId, label: r.label })
    }
    return rows
  }, [recordsQuery.data, curationQuery.data])

  /* ─── Editable taxonomy draft + debounced auto-save ────────────────────── */

  const [draft, setDraft] = useState<TaxonomyState | null>(null)
  const seededRef = useRef(false)
  const pendingRef = useRef<TaxonomyState | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveRef = useRef(save)
  saveRef.current = save

  // Persist the draft after a quiet period (spreadsheet feel — no Save button).
  const commit = useCallback((next: TaxonomyState) => {
    setDraft(next)
    pendingRef.current = next
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      if (pendingRef.current) saveRef.current.mutate(pendingRef.current)
    }, SAVE_DEBOUNCE_MS)
  }, [])

  // Seed the draft once, from the server. If the taxonomy is empty on first visit
  // and we have specimens, auto-populate a Label column from the parsed labels and
  // commit it — otherwise seed as-is (no write).
  const specimensReady =
    !recordsQuery.isLoading && !curationQuery.isLoading && !taxonomyQuery.isLoading
  useEffect(() => {
    if (seededRef.current || !specimensReady || !taxonomyQuery.data) return
    seededRef.current = true
    const server = taxonomyQuery.data
    if (server.columns.length === 0 && specimens.length > 0) {
      const assignments: TaxonomyState["assignments"] = { ...server.assignments }
      for (const s of specimens) {
        assignments[s.idSafe] = { ...(assignments[s.idSafe] ?? {}), Label: s.label }
      }
      commit({
        ...server,
        columns: [{ name: "Label", type: "categorical" }],
        assignments,
      })
    } else {
      setDraft(server)
    }
  }, [specimensReady, taxonomyQuery.data, specimens, commit])

  // Flush any pending save when leaving the stage so trailing edits aren't lost.
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        if (pendingRef.current) saveRef.current.mutate(pendingRef.current)
      }
    }
  }, [])

  /* ─── Plot axis + colour selections ─────────────────────────────────────── */

  const retained = Math.min(
    settingsQuery.data?.nComponentsRetained ?? pcaQuery.data?.nComponents ?? 1,
    pcaQuery.data?.nComponents ?? 1,
  )
  const [xPc, setXPc] = useState(1)
  const [yPc, setYPc] = useState(2)
  const [colorBy, setColorBy] = useState("none")

  // Keep the axes within the retained range as it settles after the fit loads.
  useEffect(() => {
    setXPc((p) => Math.min(Math.max(p, 1), retained))
    setYPc((p) => Math.min(Math.max(p, 1), Math.max(retained, 1)))
  }, [retained])

  const isLoading =
    !seriesKey ||
    recordsQuery.isLoading ||
    curationQuery.isLoading ||
    settingsQuery.isLoading ||
    (hasRun && pcaQuery.isLoading)
  // A fetch failure must read as an error (with retry), not "run PCA first".
  const isError =
    recordsQuery.isError ||
    curationQuery.isError ||
    settingsQuery.isError ||
    (hasRun && pcaQuery.isError)

  // Join PCA scores with the specimen metadata + taxonomy assignments by id.
  const plotData = useMemo<PlotSpecimen[]>(() => {
    const pca = pcaQuery.data
    if (!pca) return []
    const byId = new Map(specimens.map((s) => [s.idSafe, s]))
    const assignments = draft?.assignments ?? {}
    return pca.specimenIds.map((id, i) => ({
      id,
      specimenId: byId.get(id)?.specimenId ?? id,
      scores: pca.scores[i],
      metadata: assignments[id] ?? {},
    }))
  }, [pcaQuery.data, specimens, draft])

  if (isLoading) return <MorphospaceSkeleton />

  if (isError) {
    return (
      <StageMessage
        icon={<AlertTriangleIcon className="size-7" />}
        title="Couldn’t load morphospace data"
        body="The records, curation, PCA-settings, or PCA request failed. Make sure the backend is running, then retry."
        action={
          <Button
            variant="outline"
            onClick={() => {
              void recordsQuery.refetch()
              void curationQuery.refetch()
              void settingsQuery.refetch()
              void pcaQuery.refetch()
            }}
          >
            Retry
          </Button>
        }
      />
    )
  }

  if (!hasRun || !pcaQuery.data) {
    return (
      <StageMessage
        icon={<AlertTriangleIcon className="size-7" />}
        title="Run PCA in Stage 7 first"
        body="The morphospace plots each specimen at its PC scores, so it needs a PCA fit. Compute EFA (Stage 6), run PCA (Stage 7), then come back to explore and tag."
      />
    )
  }

  const columns = draft?.columns ?? []

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      {/* Header */}
      <div>
        <p className="text-sm font-medium text-muted-foreground">Stage 8</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Morphospace</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Tag specimens with metadata, then colour the shape scatter by any tag. The
          strips below each axis reconstruct what moving along that PC does to the shape.
        </p>
      </div>

      {/* Taxonomy editor */}
      {draft && (
        <TaxonomyEditor specimens={specimens} taxonomy={draft} onChange={commit} />
      )}

      {/* Morphospace scatter (lazy Plotly) */}
      <Suspense fallback={<Skeleton className="h-[28rem] w-full" />}>
        <MorphospacePlot
          data={plotData}
          columns={columns}
          retained={retained}
          xPc={xPc}
          yPc={yPc}
          colorBy={colorBy}
          onXPc={setXPc}
          onYPc={setYPc}
          onColorBy={setColorBy}
        />
      </Suspense>

      {/* Choose which groups feed the PCA fit (refits on the retained specimens) */}
      <PcaFitPanel
        specimens={specimens}
        assignments={draft?.assignments ?? {}}
        columns={columns}
        colorBy={colorBy}
        excludedSpecimens={settingsQuery.data?.excludedSpecimens ?? []}
        onApply={(excludedIds) => runPca.mutate({ excludedSpecimens: excludedIds })}
        isPending={runPca.isPending}
      />

      {/* Shape-along-PC interpreter strips */}
      <ShapeAlongPc seriesKey={seriesKey} pca={pcaQuery.data} xPc={xPc} yPc={yPc} />
    </div>
  )
}

function StageMessage({
  icon,
  title,
  body,
  action,
}: {
  icon?: React.ReactNode
  title: string
  body: string
  action?: React.ReactNode
}) {
  return (
    <div className="mx-auto mt-16 max-w-md text-center">
      {icon && (
        <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-full bg-muted text-muted-foreground">
          {icon}
        </div>
      )}
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{body}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

function MorphospaceSkeleton() {
  return (
    <div className="flex h-full flex-col gap-4">
      <Skeleton className="h-8 w-44" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-[28rem] w-full" />
    </div>
  )
}
