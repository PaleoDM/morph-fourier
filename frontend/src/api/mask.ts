// Stage 4 — Mask data hooks (ROADMAP Phase 6).
//
//   • useMask            — GET  /api/{series}/mask
//   • useSegment         — POST /api/{series}/mask/segment   (SAM; optional seeds)
//   • useSaveMask        — PUT  /api/{series}/mask/{recordKey} (optimistic anchorPath)
//   • useLockMask        — POST /api/{series}/mask/lock
//   • standardizedImageUrl — the rotated+cropped editor background URL
//
// Mutations invalidate the mask cache AND the stage-status cache on settle, so the
// thumbnail grid and the nav badge refresh together (the carried-forward
// convention). Request DTOs come from the generated `Schemas`, not domain.ts.

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
import type { MaskState, Point, SegmentResult } from "@/types/domain"

/** POST body — a SAM run request (record + optional positive/negative seeds). */
export type SegmentInput = Schemas["SegmentRequest"]
/** PUT body — the (possibly edited) anchor path to persist + resample. */
export type MaskUpdateInput = Schemas["MaskUpdateRequest"]

/**
 * The standardized (rotated+cropped) editor-background URL for one record. Anchor
 * coordinates live in exactly this image's pixel frame — the editor loads it and
 * needs no coordinate math. Same origin (`/api`) as everything else.
 *
 * Pass `width` to request a downscaled PNG (`?w=`): thumbnails ask for a small
 * width (the grid draws ~148px), the editor omits it for full resolution. Width is
 * part of the server ETag/cache key, so thumb and full-res are distinct entries.
 */
export function standardizedImageUrl(
  seriesKey: string,
  recordKey: string,
  width?: number,
): string {
  const base = `/api/${encodeURIComponent(seriesKey)}/mask/${encodeRecordKey(recordKey)}/image`
  return width ? `${base}?w=${Math.round(width)}` : base
}

/* ─── Resource functions ─────────────────────────────────────────────────── */

function getMask(seriesKey: string): Promise<MaskState> {
  return api.get<MaskState>(`/${encodeURIComponent(seriesKey)}/mask`)
}

function postSegment(seriesKey: string, body: SegmentInput): Promise<SegmentResult> {
  return api.post<SegmentResult>(`/${encodeURIComponent(seriesKey)}/mask/segment`, body)
}

function putMask(
  seriesKey: string,
  recordKey: string,
  body: MaskUpdateInput,
): Promise<MaskState> {
  return api.put<MaskState>(
    `/${encodeURIComponent(seriesKey)}/mask/${encodeRecordKey(recordKey)}`,
    body,
  )
}

function postLock(seriesKey: string): Promise<MaskState> {
  return api.post<MaskState>(`/${encodeURIComponent(seriesKey)}/mask/lock`)
}

/* ─── Hooks ──────────────────────────────────────────────────────────────── */

/** The mask state (mask.json). Disabled until a series is active. */
export function useMask(seriesKey: string | null): UseQueryResult<MaskState> {
  return useQuery({
    queryKey: queryKeys.mask(seriesKey ?? "∅"),
    queryFn: () => getMask(seriesKey as string),
    enabled: seriesKey != null,
  })
}

/**
 * Run SAM for one record and return a simplified anchor path (≤ ANCHOR_SIMPLIFY_TARGET
 * points), within the locked crop. Seeds are optional — empty seeds = a default
 * centre prompt (the primary anchor-editing workflow); positive/negative seeds
 * drive the secondary "Re-run SAM" workflow. Errors surface as a toast (e.g. 503
 * if SAM weights are missing). This is the ONLY segmentation round-trip; all
 * subsequent anchor editing is client-side.
 */
export function useSegment(seriesKey: string) {
  return useMutation({
    mutationFn: (body: SegmentInput) => postSegment(seriesKey, body),
    onError: (err) => {
      const msg =
        err instanceof ApiError ? err.message : "Couldn't run SAM — please retry."
      toast.error(msg)
    },
  })
}

/**
 * The INITIAL SAM proposal for a record, as a QUERY — not a mutation fired from a
 * mount effect. A mutation-in-`useEffect` has its result silently dropped under
 * React StrictMode's mount→unmount→remount double-invoke (the classic "fetch on
 * mount" footgun — the spinner never clears even though the backend returned the
 * outline). A query is lifecycle-managed by React Query: it survives the
 * StrictMode remount, dedupes, and its result is never lost.
 *
 * `staleTime: Infinity` because a record's proposal (record + no seeds) is stable
 * — we never want it silently re-running SAM. Enabled only when the record has no
 * saved mask yet. The explicit "Re-run SAM" / "Reset to SAM" actions still use the
 * `useSegment` mutation above (they fire on click, not in an effect, so they're
 * safe).
 */
export function useSegmentProposal(
  seriesKey: string,
  recordKey: string,
  enabled: boolean,
): UseQueryResult<SegmentResult> {
  return useQuery({
    queryKey: ["maskSegmentProposal", seriesKey, recordKey],
    queryFn: () => postSegment(seriesKey, { recordKey, seedPoints: [] }),
    enabled,
    staleTime: Infinity,
    retry: false,
  })
}

interface SaveMaskVars {
  recordKey: string
  anchorPath: Point[]
  seedPoints?: Schemas["SeedPoint"][]
}

/**
 * Persist the edited anchor path (PUT). The backend resamples it (closed
 * centripetal Catmull-Rom → arc-length) into the outline CSV Stage 6 consumes,
 * and stores `anchorPath` as the authority. Optimistic: the grid reflects the
 * saved outline immediately; on settle we invalidate the mask + status caches.
 */
export function useSaveMask(seriesKey: string) {
  const qc = useQueryClient()
  const maskKey = queryKeys.mask(seriesKey)

  return useMutation({
    mutationFn: ({ recordKey, anchorPath, seedPoints = [] }: SaveMaskVars) =>
      putMask(seriesKey, recordKey, {
        recordKey,
        anchorPath,
        seedPoints,
        source: "manual",
      }),

    onMutate: async ({ recordKey, anchorPath }) => {
      await qc.cancelQueries({ queryKey: maskKey })
      const previous = qc.getQueryData<MaskState>(maskKey)

      qc.setQueryData<MaskState>(maskKey, (old) => {
        const base: MaskState =
          old ?? {
            schemaVersion: 1,
            updatedAt: new Date().toISOString(),
            lockedAt: null,
            masks: {},
          }
        const prevEntry = base.masks[recordKey]
        return {
          ...base,
          updatedAt: new Date().toISOString(),
          masks: {
            ...base.masks,
            [recordKey]: {
              seedPoints: prevEntry?.seedPoints ?? [],
              anchorPath,
              source: "manual",
              outlinePointCount: prevEntry?.outlinePointCount ?? 1024,
              outlineRelPath: prevEntry?.outlineRelPath ?? "",
            },
          },
        }
      })

      return { previous }
    },

    onError: (_err, _vars, ctx) => {
      if (ctx?.previous !== undefined) qc.setQueryData(maskKey, ctx.previous)
      toast.error("Couldn't save that mask — please retry.")
    },

    onSettled: () => {
      void qc.invalidateQueries({ queryKey: maskKey })
      void qc.invalidateQueries({ queryKey: queryKeys.stageStatuses(seriesKey) })
    },
  })
}

/** Lock the stage (sets `lockedAt`), gating Stage 5. Refreshes badge + grid. */
export function useLockMask(seriesKey: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => postLock(seriesKey),
    onSuccess: (state) => {
      qc.setQueryData(queryKeys.mask(seriesKey), state)
      void qc.invalidateQueries({ queryKey: queryKeys.stageStatuses(seriesKey) })
    },
    onError: () => toast.error("Couldn't lock mask — please retry."),
  })
}
