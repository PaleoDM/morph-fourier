// Stage 4 — Review & Finalize data hooks (ROADMAP Phase 11D).
//
//   • useRefine  — POST /api/{series}/review/refine   (box-frame re-crop/orient/mask)
//   • useLock    — POST /api/{series}/mask/lock        (Review's lock == the mask lock)
//
// Refine overwrites one specimen's crop/orient/mask geometry from the same box-frame
// wizard Prime uses — the client ships the raw-frame crop box, the display angle, and
// a box-frame anchor path; the backend derives the upright outline and stamps a human
// source="manual", unflagged AutoResult. A refined specimen therefore leaves the
// flagged-first head of the grid. Review's Lock reuses the mask-lock endpoint (Gallery
// already soft-gates on mask.lockedAt), so nothing downstream changes.

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, ApiError, type Schemas } from "@/api/client"
import { queryKeys } from "@/api/hooks"
import type { AutoResult, MaskState } from "@/types/domain"

/** POST body — identical shape to Prime's exemplar save (crop + angle + box-frame anchors). */
export type RefineInput = Schemas["PrimeExemplarRequest"]

/* ─── Resource functions ─────────────────────────────────────────────────── */

function postRefine(seriesKey: string, body: RefineInput): Promise<AutoResult> {
  return api.post<AutoResult>(`/${encodeURIComponent(seriesKey)}/review/refine`, body)
}

function postLock(seriesKey: string): Promise<MaskState> {
  return api.post<MaskState>(`/${encodeURIComponent(seriesKey)}/mask/lock`)
}

/* ─── Hooks ──────────────────────────────────────────────────────────────── */

/**
 * Overwrite one specimen's geometry from a Review refine. On success we invalidate
 * every cache the write touched (crop/orient/mask/auto-results + the nav badges) so
 * the grid re-renders the fixed outline and re-sorts it out of the flagged head.
 */
export function useRefine(seriesKey: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: RefineInput) => postRefine(seriesKey, body),
    onSuccess: () => {
      for (const key of [
        queryKeys.crop(seriesKey),
        queryKeys.orient(seriesKey),
        queryKeys.mask(seriesKey),
        queryKeys.autoResults(seriesKey),
        queryKeys.stageStatuses(seriesKey),
      ]) {
        void qc.invalidateQueries({ queryKey: key })
      }
    },
    onError: (err) => {
      const msg =
        err instanceof ApiError ? err.message : "Couldn't save that refinement — please retry."
      toast.error(msg)
    },
  })
}

/**
 * Lock the finalized set (the mask-lock endpoint) → gates Stage 5 (Gallery). Optimistic
 * refresh via cache invalidation; a failure surfaces a toast and the lock stays open.
 */
export function useLockReview(seriesKey: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => postLock(seriesKey),
    onSuccess: (state) => {
      qc.setQueryData(queryKeys.mask(seriesKey), state)
      void qc.invalidateQueries({ queryKey: queryKeys.stageStatuses(seriesKey) })
    },
    onError: (err) => {
      const msg = err instanceof ApiError ? err.message : "Couldn't lock — please retry."
      toast.error(msg)
    },
  })
}
