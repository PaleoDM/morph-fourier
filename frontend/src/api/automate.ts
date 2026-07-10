// Stage 3 — Automate data hooks (ROADMAP Phase 11D).
//
//   • useAutoResults  — GET  /api/{series}/auto-results   (the provenance layer)
//   • useAutomate     — POST /api/{series}/automate        (the batch trigger)
//
// Automate batch-runs detect → crop → orient → mask over every non-primed canonical
// using the exemplar set, and carries each primed exemplar's human geometry forward
// into the same crop/orient/mask state (so Gallery/EFA/PCA see the full canonical
// set, not just the auto-isolated specimens). The run is synchronous — SAM box-
// predict is ~0.5 s/photo on MPS — so a spinner suffices on Apple Silicon; on
// Rebecca's Intel Mac a ~68-photo batch could be 10–20 min and will want a
// background-task + progress-stream variant (flagged for later, not built here).
//
// A successful run invalidates the crop/orient/mask/auto-results/exemplars caches
// and the stage-status badges, so Review + Gallery + the rail all reflect the batch.

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query"
import { toast } from "sonner"

import { api, ApiError } from "@/api/client"
import { queryKeys } from "@/api/hooks"
import type { AutomateSummary, AutoResultsState } from "@/types/domain"

/* ─── Resource functions ─────────────────────────────────────────────────── */

function getAutoResults(seriesKey: string): Promise<AutoResultsState> {
  return api.get<AutoResultsState>(`/${encodeURIComponent(seriesKey)}/auto-results`)
}

function postAutomate(seriesKey: string): Promise<AutomateSummary> {
  return api.post<AutomateSummary>(`/${encodeURIComponent(seriesKey)}/automate`)
}

/* ─── Hooks ──────────────────────────────────────────────────────────────── */

/** The auto-processing provenance (auto_results.json). Disabled until a series is active. */
export function useAutoResults(seriesKey: string | null): UseQueryResult<AutoResultsState> {
  return useQuery({
    queryKey: queryKeys.autoResults(seriesKey ?? "∅"),
    queryFn: () => getAutoResults(seriesKey as string),
    enabled: seriesKey != null,
  })
}

/**
 * Run the batch auto-detect. Returns the per-batch {@link AutomateSummary} counts;
 * on success we invalidate every cache the batch touched so Review + Gallery + the
 * nav badges refresh. A missing exemplar set is not an error — the summary carries
 * `skippedNoExemplars`, which the stage handles as a "prime first" message.
 * SAM weights absent → 503, surfaced as a toast.
 */
export function useAutomate(seriesKey: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => postAutomate(seriesKey),
    onSuccess: () => {
      for (const key of [
        queryKeys.crop(seriesKey),
        queryKeys.orient(seriesKey),
        queryKeys.mask(seriesKey),
        queryKeys.autoResults(seriesKey),
        queryKeys.exemplars(seriesKey),
        queryKeys.stageStatuses(seriesKey),
      ]) {
        void qc.invalidateQueries({ queryKey: key })
      }
    },
    onError: (err) => {
      const msg =
        err instanceof ApiError ? err.message : "Automate failed — please retry."
      toast.error(msg)
    },
  })
}
