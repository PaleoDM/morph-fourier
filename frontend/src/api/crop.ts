// Stage 3 — Crop data hooks (ROADMAP Phase 5).
//
//   • useCrop         — GET  /api/{series}/crop
//   • useSetCrop      — PUT  /api/{series}/crop/{recordKey}   (optimistic)
//   • useAutoCrop     — POST /api/{series}/crop/auto[?recordKey=…]  (all or one)
//   • useLockCrop     — POST /api/{series}/crop/lock
//
// Mutations invalidate the crop cache AND the stage-status cache on settle, so the
// thumbnail grid and the nav badge refresh together (the Phase 2B/4 convention).
// Request DTOs come from the generated `Schemas`, not domain.ts (CLAUDE.md).

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query"
import { toast } from "sonner"

import { api, ApiError, type Schemas } from "@/api/client"
import { queryKeys } from "@/api/hooks"
import { encodeRecordKey } from "@/api/util"
import type { CropState } from "@/types/domain"

/** The PUT body — one crop box. Typed from the API contract, not domain.ts. */
export type CropBoxInput = Schemas["CropBox"]

/* ─── Resource functions ─────────────────────────────────────────────────── */

function getCrop(seriesKey: string): Promise<CropState> {
  return api.get<CropState>(`/${encodeURIComponent(seriesKey)}/crop`)
}

function putCrop(
  seriesKey: string,
  recordKey: string,
  box: CropBoxInput,
): Promise<CropState> {
  return api.put<CropState>(
    `/${encodeURIComponent(seriesKey)}/crop/${encodeRecordKey(recordKey)}`,
    box,
  )
}

function postAutoCrop(seriesKey: string, recordKey?: string): Promise<CropState> {
  const suffix = recordKey ? `?recordKey=${encodeURIComponent(recordKey)}` : ""
  return api.post<CropState>(`/${encodeURIComponent(seriesKey)}/crop/auto${suffix}`)
}

function postLock(seriesKey: string): Promise<CropState> {
  return api.post<CropState>(`/${encodeURIComponent(seriesKey)}/crop/lock`)
}

/* ─── Hooks ──────────────────────────────────────────────────────────────── */

/** The crop state (crop.json). Disabled until a series is active. */
export function useCrop(seriesKey: string | null): UseQueryResult<CropState> {
  return useQuery({
    queryKey: queryKeys.crop(seriesKey ?? "∅"),
    queryFn: () => getCrop(seriesKey as string),
    enabled: seriesKey != null,
  })
}

interface SetCropVars {
  recordKey: string
  box: CropBoxInput
}

/**
 * Optimistic single-box upsert (a handle release). The drag reflects instantly;
 * on settle we invalidate the crop cache and the stage-status cache so the grid
 * thumbnails and the nav badge both refresh.
 */
export function useSetCrop(seriesKey: string) {
  const qc = useQueryClient()
  const cropKey = queryKeys.crop(seriesKey)

  return useMutation({
    mutationFn: ({ recordKey, box }: SetCropVars) => putCrop(seriesKey, recordKey, box),

    onMutate: async ({ recordKey, box }) => {
      await qc.cancelQueries({ queryKey: cropKey })
      const previous = qc.getQueryData<CropState>(cropKey)

      qc.setQueryData<CropState>(cropKey, (old) => {
        const base: CropState =
          old ?? {
            schemaVersion: 1,
            updatedAt: new Date().toISOString(),
            lockedAt: null,
            crops: {},
          }
        return {
          ...base,
          updatedAt: new Date().toISOString(),
          crops: { ...base.crops, [recordKey]: box },
        }
      })

      return { previous }
    },

    onError: (_err, _vars, ctx) => {
      if (ctx?.previous !== undefined) qc.setQueryData(cropKey, ctx.previous)
      toast.error("Couldn't save that crop — please retry.")
    },

    onSettled: () => {
      void qc.invalidateQueries({ queryKey: cropKey })
      void qc.invalidateQueries({ queryKey: queryKeys.stageStatuses(seriesKey) })
    },
  })
}

/**
 * Auto-suggest crop boxes from the cleaned mask bbox (backend runs SAM in the
 * rotated frame). `recordKey` omitted → every canonical ("Auto-suggest all");
 * set → just that one ("Auto-suggest this one"). On success we replace the crop
 * cache with the server's authoritative state and refresh the badge. Errors
 * surface as a toast (e.g. 503 if SAM weights are missing).
 */
export function useAutoCrop(seriesKey: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (recordKey?: string) => postAutoCrop(seriesKey, recordKey),
    onSuccess: (state) => {
      qc.setQueryData(queryKeys.crop(seriesKey), state)
      void qc.invalidateQueries({ queryKey: queryKeys.stageStatuses(seriesKey) })
    },
    onError: (err) => {
      const msg =
        err instanceof ApiError ? err.message : "Couldn't auto-suggest — please retry."
      toast.error(msg)
    },
  })
}

/** Lock the stage (sets `lockedAt`), gating Stage 4. Refreshes badge + grid. */
export function useLockCrop(seriesKey: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => postLock(seriesKey),
    onSuccess: (state) => {
      qc.setQueryData(queryKeys.crop(seriesKey), state)
      void qc.invalidateQueries({ queryKey: queryKeys.stageStatuses(seriesKey) })
    },
    onError: () => toast.error("Couldn't lock crop — please retry."),
  })
}
