// Stage 2 — Prime data hooks (ROADMAP Phase 11C).
//
//   • useExemplars       — GET    /api/{series}/exemplars           (the ExemplarSet)
//   • usePrimeSegment    — POST   /api/{series}/prime/segment       (SAM box-predict)
//   • useSaveExemplar    — PUT    /api/{series}/prime/exemplar      (optimistic upsert)
//   • useDeleteExemplar  — DELETE /api/{series}/prime/exemplar/{rk} (optimistic remove)
//   • primeImageUrl      — the cropped-raw-region editor-background URL
//
// The exemplar set is the "training data" that drives Stage 3 (Automate). Prime
// is crop-before-orient: the client ships only the raw-frame crop box, the display
// angle, and the box-frame anchor path; the backend derives the oriented outline +
// normalized efaCoeffs (so the EFA math stays server-side). Save/delete invalidate
// the exemplar cache so the grid's "N of K primed" counter refreshes.

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
import type { ExemplarSet, SegmentResult } from "@/types/domain"

/** POST body — a raw-frame box to SAM box-predict (the crop AND the prompt). */
export type PrimeSegmentInput = Schemas["PrimeSegmentRequest"]
/** PUT body — one primed exemplar's raw materials (backend derives efaCoeffs). */
export type SaveExemplarInput = Schemas["PrimeExemplarRequest"]
/** A crop rectangle in raw-photo pixels (matches the persisted `CropBox`). */
export type PrimeBox = Schemas["CropBox"]

/**
 * The cropped-raw-region PNG the Prime anchor editor + orient puck draw on. The
 * box is in raw-photo pixels; SAM anchor coords live in exactly this cropped frame
 * (no rotation — orientation is applied on Save, spec §6). Pass `width` for a
 * downscaled thumbnail; the editor omits it for full resolution.
 */
export function primeImageUrl(
  seriesKey: string,
  recordKey: string,
  box: { x1: number; y1: number; x2: number; y2: number },
  width?: number,
): string {
  const base = `/api/${encodeURIComponent(seriesKey)}/prime/${encodeRecordKey(recordKey)}/image`
  const params = new URLSearchParams({
    x1: String(Math.round(box.x1)),
    y1: String(Math.round(box.y1)),
    x2: String(Math.round(box.x2)),
    y2: String(Math.round(box.y2)),
  })
  if (width) params.set("w", String(Math.round(width)))
  return `${base}?${params.toString()}`
}

/* ─── Resource functions ─────────────────────────────────────────────────── */

function getExemplars(seriesKey: string): Promise<ExemplarSet> {
  return api.get<ExemplarSet>(`/${encodeURIComponent(seriesKey)}/exemplars`)
}

function postPrimeSegment(seriesKey: string, body: PrimeSegmentInput): Promise<SegmentResult> {
  return api.post<SegmentResult>(`/${encodeURIComponent(seriesKey)}/prime/segment`, body)
}

function putExemplar(seriesKey: string, body: SaveExemplarInput): Promise<ExemplarSet> {
  return api.put<ExemplarSet>(`/${encodeURIComponent(seriesKey)}/prime/exemplar`, body)
}

function deleteExemplar(seriesKey: string, recordKey: string): Promise<ExemplarSet> {
  return api.delete<ExemplarSet>(
    `/${encodeURIComponent(seriesKey)}/prime/exemplar/${encodeRecordKey(recordKey)}`,
  )
}

/* ─── Hooks ──────────────────────────────────────────────────────────────── */

/** The exemplar set (exemplars.json). Disabled until a series is active. */
export function useExemplars(seriesKey: string | null): UseQueryResult<ExemplarSet> {
  return useQuery({
    queryKey: queryKeys.exemplars(seriesKey ?? "∅"),
    queryFn: () => getExemplars(seriesKey as string),
    enabled: seriesKey != null,
  })
}

/**
 * SAM box-predict inside the user's raw-frame box → a simplified anchor path in the
 * box frame (the seed for the pen-tool editor). A box SAM can't segment cleanly →
 * 422; either way the error surfaces as a toast so the user redraws the box.
 */
export function usePrimeSegment(seriesKey: string) {
  return useMutation({
    mutationFn: (body: PrimeSegmentInput) => postPrimeSegment(seriesKey, body),
    onError: (err) => {
      const msg =
        err instanceof ApiError ? err.message : "Couldn't segment that box — please retry."
      toast.error(msg)
    },
  })
}

/**
 * Persist one primed exemplar (PUT). Optimistic: the grid counter reflects the new
 * exemplar immediately (a placeholder entry), and on settle we replace the cache
 * with the server's authoritative set (real oriented outline + efaCoeffs).
 */
export function useSaveExemplar(seriesKey: string) {
  const qc = useQueryClient()
  const key = queryKeys.exemplars(seriesKey)

  return useMutation({
    mutationFn: (body: SaveExemplarInput) => putExemplar(seriesKey, body),

    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: key })
      const previous = qc.getQueryData<ExemplarSet>(key)

      qc.setQueryData<ExemplarSet>(key, (old) => {
        const base: ExemplarSet = old ?? { schemaVersion: 1, harmonics: 8, exemplars: [] }
        // Optimistic placeholder: the backend fills outline/efaCoeffs on settle.
        const placeholder = {
          recordKey: body.recordKey,
          cropBox: body.cropBox,
          angleDeg: body.angleDeg,
          anchorPath: body.anchorPath,
          outline: [],
          efaCoeffs: [],
        }
        const others = base.exemplars.filter((e) => e.recordKey !== body.recordKey)
        return { ...base, exemplars: [...others, placeholder] }
      })

      return { previous }
    },

    onError: (_err, _vars, ctx) => {
      if (ctx?.previous !== undefined) qc.setQueryData(key, ctx.previous)
      toast.error("Couldn't save that exemplar — please retry.")
    },

    onSuccess: (set) => {
      qc.setQueryData(key, set)
    },

    onSettled: () => {
      void qc.invalidateQueries({ queryKey: key })
    },
  })
}

/** Un-prime a specimen (DELETE). Optimistic removal; server set replaces on settle. */
export function useDeleteExemplar(seriesKey: string) {
  const qc = useQueryClient()
  const key = queryKeys.exemplars(seriesKey)

  return useMutation({
    mutationFn: (recordKey: string) => deleteExemplar(seriesKey, recordKey),

    onMutate: async (recordKey) => {
      await qc.cancelQueries({ queryKey: key })
      const previous = qc.getQueryData<ExemplarSet>(key)
      qc.setQueryData<ExemplarSet>(key, (old) =>
        old ? { ...old, exemplars: old.exemplars.filter((e) => e.recordKey !== recordKey) } : old,
      )
      return { previous }
    },

    onError: (_err, _vars, ctx) => {
      if (ctx?.previous !== undefined) qc.setQueryData(key, ctx.previous)
      toast.error("Couldn't remove that exemplar — please retry.")
    },

    onSuccess: (set) => {
      qc.setQueryData(key, set)
    },
  })
}
