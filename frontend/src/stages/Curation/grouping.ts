// Grouping + per-specimen review state for the Curation stage.
//
// The backend already sorts records by (specimenIdSafe, photoIndex), so grouping
// in first-seen order keeps multi-photo specimens contiguous and ordered.

import type { PhotoDecision, PhotoRecord } from "@/types/domain"

export interface SpecimenGroup {
  specimenKey: string
  specimenId: string
  label: string
  records: PhotoRecord[]
}

/** Group records by `specimenKey`, preserving the backend's ordering. */
export function groupBySpecimen(records: PhotoRecord[]): SpecimenGroup[] {
  const byKey = new Map<string, SpecimenGroup>()
  for (const rec of records) {
    let group = byKey.get(rec.specimenKey)
    if (!group) {
      group = {
        specimenKey: rec.specimenKey,
        specimenId: rec.specimenId,
        label: rec.label,
        records: [],
      }
      byKey.set(rec.specimenKey, group)
    }
    group.records.push(rec)
  }
  return [...byKey.values()]
}

export type SpecimenState = "canonical" | "rejected" | "in-review" | "new"

/**
 * Coarse review state for a specimen group, driving its badge and the stage
 * progress count. "canonical" (a canonical is chosen) and "rejected" (every
 * photo rejected) both count as *reviewed*; the rest are still open.
 */
export function specimenState(
  group: SpecimenGroup,
  photos: Record<string, PhotoDecision>,
): SpecimenState {
  const decisions = group.records.map((r) => photos[r.recordKey])
  const hasCanonical = decisions.some((d) => d?.isCanonical && d.status === "accepted")
  if (hasCanonical) return "canonical"
  const allRejected =
    group.records.length > 0 && decisions.every((d) => d?.status === "rejected")
  if (allRejected) return "rejected"
  const anyReviewed = decisions.some((d) => d != null && d.status !== "unreviewed")
  return anyReviewed ? "in-review" : "new"
}

/** Whether a specimen counts toward the reviewed/total progress figure. */
export function isReviewed(state: SpecimenState): boolean {
  return state === "canonical" || state === "rejected"
}
