// Stage 7 — PCA data hooks (ROADMAP Phase 8).
//
//   • usePcaSettings — GET  /api/{series}/pca/settings → PcaSettings (always 200,
//                      defaults if never run). Carries lastComputedAt (has it run?)
//                      and harmonicsUsed (the drift-banner input).
//   • usePca         — GET  /api/{series}/pca          → PcaResult. 404s until the
//                      first run, so it's gated on `hasRun` by the caller.
//   • useRunPca      — POST /api/{series}/pca/run       → writes scores/loadings/
//                      eigenvalues CSVs, returns the fresh PcaResult.
//
// Run mutates persisted settings, so it invalidates pca + pcaSettings + stageStatuses.

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query"
import { toast } from "sonner"

import { api, ApiError, type Schemas } from "@/api/client"
import { queryKeys } from "@/api/hooks"
import type { PcaResult } from "@/types/domain"

/** Persisted PCA settings — mirrored from the backend model (not in domain.ts). */
export type PcaSettings = Schemas["PcaSettings"]
/** POST body for run — both optional; omit for auto retained-count from the target. */
export type PcaRunInput = Schemas["PcaRunRequest"]

/* ─── Resource functions ─────────────────────────────────────────────────── */

function getPcaSettings(seriesKey: string): Promise<PcaSettings> {
  return api.get<PcaSettings>(`/${encodeURIComponent(seriesKey)}/pca/settings`)
}

function getPca(seriesKey: string): Promise<PcaResult> {
  return api.get<PcaResult>(`/${encodeURIComponent(seriesKey)}/pca`)
}

function postRunPca(seriesKey: string, body: PcaRunInput): Promise<PcaResult> {
  return api.post<PcaResult>(`/${encodeURIComponent(seriesKey)}/pca/run`, body)
}

/* ─── Hooks ──────────────────────────────────────────────────────────────── */

/** Persisted PCA settings — always resolves (defaults before the first run). */
export function usePcaSettings(
  seriesKey: string | null,
): UseQueryResult<PcaSettings> {
  return useQuery({
    queryKey: queryKeys.pcaSettings(seriesKey ?? "∅"),
    queryFn: () => getPcaSettings(seriesKey as string),
    enabled: seriesKey != null,
  })
}

/**
 * The full PCA result (scores / variance / loadings), recomputed deterministically
 * from the coefficients. `hasRun` gates it: the endpoint 404s until the first run,
 * and we learn that from usePcaSettings.lastComputedAt without provoking the 404.
 */
export function usePca(
  seriesKey: string | null,
  hasRun: boolean,
): UseQueryResult<PcaResult> {
  return useQuery({
    queryKey: queryKeys.pca(seriesKey ?? "∅"),
    queryFn: () => getPca(seriesKey as string),
    enabled: seriesKey != null && hasRun,
  })
}

/** Fit PCA and persist scores/loadings/eigenvalues + the settings used. */
export function useRunPca(seriesKey: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: PcaRunInput) => postRunPca(seriesKey, body),
    onSuccess: (result) => {
      toast.success(
        `PCA fit — ${result.nComponents} component${
          result.nComponents === 1 ? "" : "s"
        } over ${result.specimenIds.length} specimens.`,
      )
    },
    onError: (err) => {
      toast.error(
        err instanceof ApiError ? err.message : "Couldn’t run PCA — please retry.",
      )
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.pca(seriesKey) })
      void qc.invalidateQueries({ queryKey: queryKeys.pcaSettings(seriesKey) })
      void qc.invalidateQueries({ queryKey: queryKeys.stageStatuses(seriesKey) })
    },
  })
}
