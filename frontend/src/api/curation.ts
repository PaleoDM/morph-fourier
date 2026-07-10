// Stage 1 — Curation data hooks (ROADMAP Phase 3 step 1).
//
// Three hooks over the live backend:
//   • useSeriesRecords — GET /api/{series}/records  (photo grid data + unparseable)
//   • useCuration       — GET /api/{series}/curation (the decisions map)
//   • useSetDecision    — PUT /api/{series}/curation/{recordKey}, optimistic
//
// Request DTOs come from the generated `Schemas` (the OpenAPI contract), not
// domain.ts, so the wire shape can never drift from the server (CLAUDE.md).

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type Schemas } from "@/api/client"
import { queryKeys } from "@/api/hooks"
import { encodeRecordKey } from "@/api/util"
import type { CurationState, SeriesRecords } from "@/types/domain"

/** The PUT body — the decision to upsert. Typed from the API contract, not domain.ts. */
export type DecisionInput = Schemas["PhotoDecision"]

/* ─── Resource functions ─────────────────────────────────────────────────── */

function getSeriesRecords(seriesKey: string): Promise<SeriesRecords> {
  return api.get<SeriesRecords>(`/${encodeURIComponent(seriesKey)}/records`)
}

function getCuration(seriesKey: string): Promise<CurationState> {
  return api.get<CurationState>(`/${encodeURIComponent(seriesKey)}/curation`)
}

function putDecision(
  seriesKey: string,
  recordKey: string,
  decision: DecisionInput,
): Promise<CurationState> {
  return api.put<CurationState>(
    `/${encodeURIComponent(seriesKey)}/curation/${encodeRecordKey(recordKey)}`,
    decision,
  )
}

/* ─── Hooks ──────────────────────────────────────────────────────────────── */

/** Parsed source records for the grid. Disabled until a series is active. */
export function useSeriesRecords(
  seriesKey: string | null,
): UseQueryResult<SeriesRecords> {
  return useQuery({
    queryKey: queryKeys.records(seriesKey ?? "∅"),
    queryFn: () => getSeriesRecords(seriesKey as string),
    enabled: seriesKey != null,
  })
}

/** The curation decisions map (curation.json). Disabled until a series is active. */
export function useCuration(
  seriesKey: string | null,
): UseQueryResult<CurationState> {
  return useQuery({
    queryKey: queryKeys.curation(seriesKey ?? "∅"),
    queryFn: () => getCuration(seriesKey as string),
    enabled: seriesKey != null,
  })
}

interface SetDecisionVars {
  recordKey: string
  decision: DecisionInput
}

/**
 * Optimistic decision upsert. Clicking Accept/Reject/canonical reflects instantly;
 * on settle we invalidate both the curation cache and the stage-status cache so the
 * grid and the nav badges refresh (the 2B convention).
 *
 * The one-canonical-per-specimen rule is enforced authoritatively by the backend;
 * we mirror it optimistically (clearing sibling canonicals in the same specimenKey)
 * so the UI never briefly shows two canonicals before the server response lands.
 */
export function useSetDecision(seriesKey: string) {
  const qc = useQueryClient()
  const curationKey = queryKeys.curation(seriesKey)
  const recordsKey = queryKeys.records(seriesKey)

  return useMutation({
    mutationFn: ({ recordKey, decision }: SetDecisionVars) =>
      putDecision(seriesKey, recordKey, decision),

    onMutate: async ({ recordKey, decision }) => {
      await qc.cancelQueries({ queryKey: curationKey })
      const previous = qc.getQueryData<CurationState>(curationKey)

      // Which records share this photo's specimen? (for optimistic canonical clear)
      const records = qc.getQueryData<SeriesRecords>(recordsKey)?.records ?? []
      const specimenKey = records.find((r) => r.recordKey === recordKey)?.specimenKey
      const siblingKeys = new Set(
        records
          .filter((r) => r.specimenKey === specimenKey && r.recordKey !== recordKey)
          .map((r) => r.recordKey),
      )

      qc.setQueryData<CurationState>(curationKey, (old) => {
        const base: CurationState =
          old ?? { schemaVersion: 1, updatedAt: new Date().toISOString(), photos: {} }
        const photos = { ...base.photos }
        if (decision.isCanonical) {
          // Clear any prior canonical among this specimen's other photos.
          for (const rk of siblingKeys) {
            const sib = photos[rk]
            if (sib?.isCanonical) photos[rk] = { ...sib, isCanonical: false }
          }
        }
        photos[recordKey] = {
          status: decision.status,
          rejectionReason: decision.rejectionReason ?? null,
          isCanonical: decision.isCanonical,
          notes: decision.notes,
        }
        return { ...base, updatedAt: new Date().toISOString(), photos }
      })

      return { previous }
    },

    onError: (_err, _vars, ctx) => {
      // Roll back the optimistic write and surface the failure.
      if (ctx?.previous !== undefined) qc.setQueryData(curationKey, ctx.previous)
      toast.error("Couldn't save that change — please retry.")
    },

    onSettled: () => {
      void qc.invalidateQueries({ queryKey: curationKey })
      void qc.invalidateQueries({ queryKey: queryKeys.stageStatuses(seriesKey) })
    },
  })
}
