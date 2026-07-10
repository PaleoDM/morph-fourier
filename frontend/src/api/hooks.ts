// Data hooks — the ONLY way components read server data.
//
// Each hook has its final, real-world signature. As of Phase 2B they resolve
// against the live backend through the typed client in `client.ts` (the Phase-2A
// mock seam has been removed). Wrapping everything in TanStack Query keeps the
// loading / empty / error states genuine.

import { useQuery, type UseQueryResult } from "@tanstack/react-query"

import type { Series, StageStatus, StageId } from "@/types/domain"
import { useActiveSeriesStore } from "@/state/useActiveSeriesStore"
import { getSeriesList, getSeriesStatus } from "@/api/client"

/** Query key factory — one place so cache invalidation in later phases is consistent. */
export const queryKeys = {
  series: ["series"] as const,
  // One key backs both the aggregate status hook and every single-stage hook,
  // so the rail and any stage screen dedupe to a single `/status` request.
  stageStatuses: (seriesKey: string) => ["stageStatuses", seriesKey] as const,
  // Parsed source records (photo grid data) — one call per series.
  records: (seriesKey: string) => ["records", seriesKey] as const,
  // Curation decisions (curation.json). Mutations invalidate this so the grid
  // and the stage-status badges both refresh (the convention 2B established).
  curation: (seriesKey: string) => ["curation", seriesKey] as const,
  // Orientation state (orient.json). Mutations invalidate this + stageStatuses
  // so the thumbnail grid and the nav badge refresh together (Phase 4).
  orient: (seriesKey: string) => ["orient", seriesKey] as const,
  // Crop state (crop.json). Mutations invalidate this + stageStatuses so the
  // crop grid and the nav badge refresh together (Phase 5, same convention).
  crop: (seriesKey: string) => ["crop", seriesKey] as const,
  // Mask state (mask.json). Mutations invalidate this + stageStatuses so the
  // mask grid and the nav badge refresh together (Phase 6, same convention).
  mask: (seriesKey: string) => ["mask", seriesKey] as const,
  // EFA settings (efa_settings.json). Compute invalidates this + stageStatuses;
  // it also invalidates pca so the drift banner re-evaluates (Phase 8).
  efa: (seriesKey: string) => ["efa", seriesKey] as const,
  // One EFA reconstruction (Stage 6 inspector), keyed by the exact inputs so a
  // repeat inspector view is a cache hit (mirrors the backend LRU).
  efaReconstruct: (
    seriesKey: string,
    recordKey: string,
    harmonics: number,
    normalize: boolean,
    anchor: string,
  ) => ["efaReconstruct", seriesKey, recordKey, harmonics, normalize, anchor] as const,
  // PCA result (recomputed from coefficients) + persisted PCA settings (Phase 8).
  pca: (seriesKey: string) => ["pca", seriesKey] as const,
  pcaSettings: (seriesKey: string) => ["pcaSettings", seriesKey] as const,
  // One PCA back-projection (Stage 8 shape-along-PC strip), keyed by the exact
  // PC-value point so every ±σ strip cell is an independent cache entry.
  pcaReconstruct: (seriesKey: string, pcValuesKey: string) =>
    ["pcaReconstruct", seriesKey, pcValuesKey] as const,
  // Taxonomy metadata table (taxonomy.json). PUT invalidates this + stageStatuses
  // (the morphospace nav badge tracks lastComputedAt) — the Phase-8 convention.
  taxonomy: (seriesKey: string) => ["taxonomy", seriesKey] as const,
  // Exemplar set (exemplars.json). Prime (Stage 2) writes it per specimen; the
  // save/delete mutations invalidate this so the grid counter refreshes (Phase 11C).
  exemplars: (seriesKey: string) => ["exemplars", seriesKey] as const,
  // Auto-processing provenance (auto_results.json). Automate (Stage 3) writes it;
  // Review (Stage 4) reads it for flagged-first ordering + flag explanations, and
  // the refine mutation invalidates it so a fixed specimen leaves the flagged head.
  autoResults: (seriesKey: string) => ["autoResults", seriesKey] as const,
}

/** All series discovered under the photos root. Drives the SeriesSelector + EmptyState. */
export function useSeriesList(): UseQueryResult<Series[]> {
  return useQuery({
    queryKey: queryKeys.series,
    queryFn: getSeriesList,
  })
}

/**
 * All eight stage statuses for the currently-active series, keyed by StageId.
 * StageNav reads this to render completion badges in one fetch. Disabled until a
 * series is active (so no query fires on the empty-state / first-load screen).
 *
 * Backed by `GET /api/{series}/status`, which returns every stage — including
 * `gallery` and `morphospace`, which have no dedicated per-stage status route.
 */
export function useActiveSeriesStatus(): UseQueryResult<
  Record<StageId, StageStatus>
> {
  const activeSeriesKey = useActiveSeriesStore((s) => s.activeSeriesKey)
  return useQuery({
    queryKey: queryKeys.stageStatuses(activeSeriesKey ?? "∅"),
    queryFn: () => getSeriesStatus(activeSeriesKey as string),
    enabled: activeSeriesKey != null,
  })
}

/**
 * Status for a single stage of the active series. The per-stage screens added in
 * Phases 3–9 use the named wrappers below; this is the shared implementation.
 *
 * It reads the *aggregate* `/api/{series}/status` and selects the one stage,
 * rather than hitting a `/{stage}/status` route: two stages (`gallery`,
 * `morphospace`) have no per-stage status endpoint, and sharing the aggregate
 * query key with `useActiveSeriesStatus` means the rail and any single-stage
 * screen dedupe to one network request.
 */
export function useStageStatus(stageId: StageId): UseQueryResult<StageStatus> {
  const activeSeriesKey = useActiveSeriesStore((s) => s.activeSeriesKey)
  return useQuery({
    queryKey: queryKeys.stageStatuses(activeSeriesKey ?? "∅"),
    queryFn: () => getSeriesStatus(activeSeriesKey as string),
    enabled: activeSeriesKey != null,
    select: (all) => all[stageId],
  })
}

// Named per-stage hooks (ROADMAP Phase 2 step 5). Thin wrappers so each stage
// screen imports its own hook without repeating the stage id. The retired
// Orient/Crop/Mask stages (Phase 11D) dropped their wrappers; Gallery/EFA/PCA read
// the same crop/orient/mask *state* directly (useCrop/useOrient/useMask), unchanged.
export const useCurationStatus = () => useStageStatus("curation")
export const useGalleryStatus = () => useStageStatus("gallery")
export const useEfaStatus = () => useStageStatus("efa")
export const usePcaStatus = () => useStageStatus("pca")
export const useMorphospaceStatus = () => useStageStatus("morphospace")
