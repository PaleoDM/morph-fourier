// Stage 6 — EFA data hooks (ROADMAP Phase 8).
//
//   • useEfa          — GET  /api/{series}/efa           → EfaSettings (persisted)
//   • useCalibrate    — POST /api/{series}/efa/calibrate → CalibrationResult
//   • useComputeEfa   — POST /api/{series}/efa/compute   → writes coefficients.csv
//   • useReconstruct  — POST /api/{series}/efa/reconstruct (inspector) as a QUERY
//
// Compute mutates persisted settings, so on success it invalidates efa (settings),
// stageStatuses (nav badge), AND pca (its drift banner compares harmonicsUsed to
// the current EFA harmonics). Reconstruct is read-only + cacheable, so it's a
// TanStack query (never a mount-fired mutation — the Phase-6 rule), keyed by the
// exact inputs to mirror the backend's per-(record,harmonics,normalize) LRU.

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query"
import { toast } from "sonner"

import { api, ApiError, type Schemas } from "@/api/client"
import { queryKeys } from "@/api/hooks"
import type {
  AnchorDir,
  CalibrationResult,
  EfaSettings,
  ReconstructResult,
} from "@/types/domain"

/** POST body for compute — both optional; omit to reuse persisted settings. */
export type EfaComputeInput = Schemas["EfaComputeRequest"]

/* ─── Resource functions ─────────────────────────────────────────────────── */

function getEfa(seriesKey: string): Promise<EfaSettings> {
  return api.get<EfaSettings>(`/${encodeURIComponent(seriesKey)}/efa`)
}

function postCalibrate(seriesKey: string): Promise<CalibrationResult> {
  return api.post<CalibrationResult>(`/${encodeURIComponent(seriesKey)}/efa/calibrate`)
}

function postCompute(
  seriesKey: string,
  body: EfaComputeInput,
): Promise<EfaSettings> {
  return api.post<EfaSettings>(`/${encodeURIComponent(seriesKey)}/efa/compute`, body)
}

function postReconstruct(
  seriesKey: string,
  recordKey: string,
  harmonics: number,
  normalize: boolean,
  anchor: AnchorDir,
): Promise<ReconstructResult> {
  return api.post<ReconstructResult>(
    `/${encodeURIComponent(seriesKey)}/efa/reconstruct`,
    { recordKey, harmonics, normalize, anchor },
  )
}

/* ─── Hooks ──────────────────────────────────────────────────────────────── */

/** Persisted EFA settings (harmonics / normalize / lastComputedAt). */
export function useEfa(seriesKey: string | null): UseQueryResult<EfaSettings> {
  return useQuery({
    queryKey: queryKeys.efa(seriesKey ?? "∅"),
    queryFn: () => getEfa(seriesKey as string),
    enabled: seriesKey != null,
  })
}

/**
 * Calibrate the harmonic count. Pools the per-specimen cumulative-power curves on
 * the backend and returns the mean curve + 95/99/99.9% recommendations. Pure read
 * (writes no state) so it just returns the result to the caller — no invalidation.
 */
export function useCalibrate(seriesKey: string) {
  return useMutation({
    mutationFn: () => postCalibrate(seriesKey),
    onError: (err) => {
      toast.error(
        err instanceof ApiError ? err.message : "Couldn’t calibrate — please retry.",
      )
    },
  })
}

/** Compute EFA coefficients for all canonicals and persist the settings used. */
export function useComputeEfa(seriesKey: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: EfaComputeInput) => postCompute(seriesKey, body),
    onSuccess: (settings) => {
      toast.success(
        `EFA computed — ${settings.nSpecimensComputed} specimen${
          settings.nSpecimensComputed === 1 ? "" : "s"
        } at ${settings.harmonics} harmonics.`,
      )
    },
    onError: (err) => {
      toast.error(
        err instanceof ApiError ? err.message : "Couldn’t compute EFA — please retry.",
      )
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.efa(seriesKey) })
      void qc.invalidateQueries({ queryKey: queryKeys.stageStatuses(seriesKey) })
      // PCA's drift banner reads the current EFA harmonics — refresh it too.
      void qc.invalidateQueries({ queryKey: queryKeys.pcaSettings(seriesKey) })
    },
  })
}

/**
 * One specimen's reconstruction + power spectrum for the Stage-6 inspector.
 * Disabled until a specimen is chosen. Cached by (record, harmonics, normalize)
 * so flipping back to a previously-viewed specimen is instant.
 */
export function useReconstruct(
  seriesKey: string | null,
  recordKey: string | null,
  harmonics: number,
  normalize: boolean,
  anchor: AnchorDir,
): UseQueryResult<ReconstructResult> {
  return useQuery({
    queryKey: queryKeys.efaReconstruct(
      seriesKey ?? "∅",
      recordKey ?? "∅",
      harmonics,
      normalize,
      anchor,
    ),
    queryFn: () =>
      postReconstruct(seriesKey as string, recordKey as string, harmonics, normalize, anchor),
    enabled: seriesKey != null && recordKey != null,
  })
}
