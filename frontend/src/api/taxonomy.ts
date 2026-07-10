// Stage 8 — Taxonomy + morphospace back-projection hooks (ROADMAP Phase 9).
//
//   • useTaxonomy        — GET  /api/{series}/taxonomy → TaxonomyState (always 200,
//                          empty columns/assignments before the first save).
//   • useSaveTaxonomy    — PUT  /api/{series}/taxonomy → persists the whole table.
//                          Save invalidates taxonomy + stageStatuses (the morphospace
//                          nav badge). Debounced auto-save calls this from the editor.
//   • usePcaReconstruct  — POST /api/{series}/pca/reconstruct as a QUERY (read-only,
//                          deterministic, cacheable — never a mount-fired mutation).
//                          One instance per ±σ strip cell; keyed by the PC-value point.
//
// The reconstruct endpoint mirrors a backend LRU; keying each query by the exact
// {pcIndex: score} point means re-viewing the same strip is an instant cache hit.

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query"
import { toast } from "sonner"

import { api, ApiError } from "@/api/client"
import { queryKeys } from "@/api/hooks"
import type { ReconstructResult, TaxonomyState } from "@/types/domain"

/* ─── Resource functions ─────────────────────────────────────────────────── */

function getTaxonomy(seriesKey: string): Promise<TaxonomyState> {
  return api.get<TaxonomyState>(`/${encodeURIComponent(seriesKey)}/taxonomy`)
}

function putTaxonomy(
  seriesKey: string,
  state: TaxonomyState,
): Promise<TaxonomyState> {
  return api.put<TaxonomyState>(`/${encodeURIComponent(seriesKey)}/taxonomy`, state)
}

/** PC index → score along that PC (others held at 0). Matches the backend's `pcValues`. */
export type PcValues = Record<string, number>

function postPcaReconstruct(
  seriesKey: string,
  pcValues: PcValues,
): Promise<ReconstructResult> {
  return api.post<ReconstructResult>(
    `/${encodeURIComponent(seriesKey)}/pca/reconstruct`,
    { pcValues },
  )
}

/* ─── Hooks ──────────────────────────────────────────────────────────────── */

/** The persisted taxonomy table. Always resolves (empty before the first save). */
export function useTaxonomy(
  seriesKey: string | null,
): UseQueryResult<TaxonomyState> {
  return useQuery({
    queryKey: queryKeys.taxonomy(seriesKey ?? "∅"),
    queryFn: () => getTaxonomy(seriesKey as string),
    enabled: seriesKey != null,
  })
}

/**
 * Replace the whole taxonomy table. Auto-save (debounced) calls this on every edit;
 * a manual add/remove-column calls it immediately. Toasts only on error — silent
 * success keeps the spreadsheet feel. Invalidates taxonomy + the morphospace badge.
 */
export function useSaveTaxonomy(seriesKey: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (state: TaxonomyState) => putTaxonomy(seriesKey, state),
    onError: (err) => {
      toast.error(
        err instanceof ApiError
          ? err.message
          : "Couldn’t save the taxonomy — please retry.",
      )
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.taxonomy(seriesKey) })
      void qc.invalidateQueries({ queryKey: queryKeys.stageStatuses(seriesKey) })
    },
  })
}

/**
 * Back-project one point in PC space to a closed outline (Stage-8 shape-along-PC).
 * A query, not a mutation: read-only + deterministic, so re-viewing a strip is a
 * cache hit (and the Phase-6 rule bars mount-fired mutations). Disabled until the
 * caller passes a series + a non-empty point.
 */
export function usePcaReconstruct(
  seriesKey: string | null,
  pcValues: PcValues,
): UseQueryResult<ReconstructResult> {
  // Stable, order-independent key so {1:1,2:0} and {2:0,1:1} share a cache entry.
  const pcValuesKey = Object.keys(pcValues)
    .map(Number)
    .sort((a, b) => a - b)
    .map((k) => `${k}:${pcValues[String(k)]}`)
    .join(",")
  return useQuery({
    queryKey: queryKeys.pcaReconstruct(seriesKey ?? "∅", pcValuesKey),
    queryFn: () => postPcaReconstruct(seriesKey as string, pcValues),
    enabled: seriesKey != null && Object.keys(pcValues).length > 0,
    staleTime: Infinity, // deterministic for a given fit; invalidated on re-run elsewhere
  })
}
