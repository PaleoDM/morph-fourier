// Stage 5 — Gallery / Export data hooks (ROADMAP Phase 7).
//
//   • useExport — POST /api/{series}/export → ExportResult
//
// The gallery grid itself needs no new query: it joins the existing
// useSeriesRecords / useCuration / useCrop / useMask / useOrient caches
// client-side to find which canonicals are ready (see Gallery/readiness.ts).
// Export is the only server round-trip and it only writes derived files under
// out/ — it changes no stage state — so it just toasts the outcome.

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, ApiError } from "@/api/client"
import { queryKeys } from "@/api/hooks"
import type { ExportResult } from "@/types/domain"

function postExport(seriesKey: string): Promise<ExportResult> {
  return api.post<ExportResult>(`/${encodeURIComponent(seriesKey)}/export`)
}

/**
 * Write the Momocs export bundle (out/{images,outlines,manifest.csv}) for the
 * series. Reports the outcome as a toast — how many specimens were exported and,
 * if any, how many were skipped for missing artifacts. Invalidates stageStatuses
 * on settle per the carry-forward convention (a no-op for readiness, but keeps the
 * mutation pattern uniform).
 */
export function useExport(seriesKey: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => postExport(seriesKey),
    onSuccess: (result) => {
      const skipped = result.skipped.length
      toast.success(
        `Exported ${result.exportedCount} outline${result.exportedCount === 1 ? "" : "s"}` +
          (skipped ? ` — ${skipped} skipped (missing artifacts)` : ""),
        { description: result.manifestPath },
      )
    },
    onError: (err) => {
      const msg =
        err instanceof ApiError ? err.message : "Couldn't export — please retry."
      toast.error(msg)
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.stageStatuses(seriesKey) })
    },
  })
}
