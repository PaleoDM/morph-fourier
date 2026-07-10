// Stage 2 — Orient data hooks (ROADMAP Phase 4).
//
//   • useOrient                     — GET  /api/{series}/orient
//   • useSetOrientation             — PUT  /api/{series}/orient/{recordKey}  (optimistic)
//   • useBuildReferenceAndAutoOrient— POST /api/{series}/orient/build-reference
//   • useReferencePreview           — GET  /api/{series}/orient/reference-preview
//   • useLockOrient                 — POST /api/{series}/orient/lock
//
// Mutations invalidate the orient cache AND the stage-status cache on settle, so
// the thumbnail grid and the nav badge refresh together (the Phase 2B/3 convention).
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
import type { OrientState, ReconstructResult } from "@/types/domain"

/** The PUT body — one orientation. Typed from the API contract, not domain.ts. */
export type OrientationInput = Schemas["Orientation"]

/* ─── Resource functions ─────────────────────────────────────────────────── */

function getOrient(seriesKey: string): Promise<OrientState> {
  return api.get<OrientState>(`/${encodeURIComponent(seriesKey)}/orient`)
}

function putOrientation(
  seriesKey: string,
  recordKey: string,
  orientation: OrientationInput,
): Promise<OrientState> {
  return api.put<OrientState>(
    `/${encodeURIComponent(seriesKey)}/orient/${encodeRecordKey(recordKey)}`,
    orientation,
  )
}

function postBuildReference(seriesKey: string): Promise<OrientState> {
  return api.post<OrientState>(`/${encodeURIComponent(seriesKey)}/orient/build-reference`)
}

function getReferencePreview(seriesKey: string): Promise<ReconstructResult> {
  return api.get<ReconstructResult>(
    `/${encodeURIComponent(seriesKey)}/orient/reference-preview`,
  )
}

function postLock(seriesKey: string): Promise<OrientState> {
  return api.post<OrientState>(`/${encodeURIComponent(seriesKey)}/orient/lock`)
}

/* ─── Hooks ──────────────────────────────────────────────────────────────── */

/** The orientation state (orient.json). Disabled until a series is active. */
export function useOrient(seriesKey: string | null): UseQueryResult<OrientState> {
  return useQuery({
    queryKey: queryKeys.orient(seriesKey ?? "∅"),
    queryFn: () => getOrient(seriesKey as string),
    enabled: seriesKey != null,
  })
}

interface SetOrientationVars {
  recordKey: string
  orientation: OrientationInput
}

/**
 * Optimistic single-orientation upsert (a puck drag → `source = "manual"`).
 * Dragging reflects instantly; on settle we invalidate the orient cache and the
 * stage-status cache so the grid thumbnails and the nav badge both refresh.
 */
export function useSetOrientation(seriesKey: string) {
  const qc = useQueryClient()
  const orientKey = queryKeys.orient(seriesKey)

  return useMutation({
    mutationFn: ({ recordKey, orientation }: SetOrientationVars) =>
      putOrientation(seriesKey, recordKey, orientation),

    onMutate: async ({ recordKey, orientation }) => {
      await qc.cancelQueries({ queryKey: orientKey })
      const previous = qc.getQueryData<OrientState>(orientKey)

      qc.setQueryData<OrientState>(orientKey, (old) => {
        const base: OrientState =
          old ?? {
            schemaVersion: 1,
            updatedAt: new Date().toISOString(),
            lockedAt: null,
            orientations: {},
            learnedReference: null,
          }
        return {
          ...base,
          updatedAt: new Date().toISOString(),
          orientations: { ...base.orientations, [recordKey]: orientation },
        }
      })

      return { previous }
    },

    onError: (_err, _vars, ctx) => {
      if (ctx?.previous !== undefined) qc.setQueryData(orientKey, ctx.previous)
      toast.error("Couldn't save that rotation — please retry.")
    },

    onSettled: () => {
      void qc.invalidateQueries({ queryKey: orientKey })
      void qc.invalidateQueries({ queryKey: queryKeys.stageStatuses(seriesKey) })
    },
  })
}

/**
 * Build the learned reference from the primed examples, then auto-orient every
 * remaining canonical (backend runs SAM → PCA → EFA-8). This is the heavy call;
 * on success we replace the orient cache with the server's authoritative state
 * and refresh the badge. Errors surface as a toast (e.g. 503 if SAM weights are
 * missing, or "prime N examples first").
 */
export function useBuildReferenceAndAutoOrient(seriesKey: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => postBuildReference(seriesKey),
    onSuccess: (state) => {
      qc.setQueryData(queryKeys.orient(seriesKey), state)
      void qc.invalidateQueries({ queryKey: queryKeys.stageStatuses(seriesKey) })
    },
    onError: (err) => {
      const msg =
        err instanceof ApiError
          ? err.message
          : "Couldn't build the reference — please retry."
      toast.error(msg)
    },
  })
}

/**
 * The reconstructed mean/reference outline for the sanity preview. Only fetched
 * once a reference exists (`enabled`); a 404 (no reference yet) is not retried.
 */
export function useReferencePreview(
  seriesKey: string | null,
  enabled: boolean,
): UseQueryResult<ReconstructResult> {
  return useQuery({
    queryKey: [...queryKeys.orient(seriesKey ?? "∅"), "reference-preview"],
    queryFn: () => getReferencePreview(seriesKey as string),
    enabled: seriesKey != null && enabled,
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 2,
  })
}

/** Lock the stage (sets `lockedAt`), gating Stage 3. Refreshes badge + grid. */
export function useLockOrient(seriesKey: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => postLock(seriesKey),
    onSuccess: (state) => {
      qc.setQueryData(queryKeys.orient(seriesKey), state)
      void qc.invalidateQueries({ queryKey: queryKeys.stageStatuses(seriesKey) })
    },
    onError: () => toast.error("Couldn't lock orientation — please retry."),
  })
}
