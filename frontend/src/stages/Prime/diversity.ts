// The diversity nudge (Prime, spec §2): matching is nearest-of-K exemplars, never
// their mean, so the exemplar set must SPAN the dataset's shape variety — one of
// each rough taxon/shape, not the first N. We can't cluster shapes before they're
// masked, so we proxy "shape group" by the parsed genus (the first token of the
// filename-derived label), which tracks taxonomic — hence gross-shape — variety on
// this dataset. Frontend-only heuristic; it only orders suggestions and reports
// coverage, never gates anything.

import type { PhotoRecord } from "@/types/domain"

/** Coarse group key for a record — the genus token, lowercased (falls back to id). */
export function groupKey(record: PhotoRecord): string {
  const first = record.label?.trim().split(/[\s_]+/)[0]?.toLowerCase()
  return first && /[a-z]/.test(first) ? first : record.specimenIdSafe.toLowerCase()
}

export interface DiversityStat {
  totalGroups: number      // distinct groups across the canonical set
  coveredGroups: number    // groups with at least one primed exemplar
  /** A suggested next record to prime: one from the largest not-yet-covered group. */
  suggestion: PhotoRecord | null
}

/**
 * Coverage of the shape groups by the primed set, plus a suggested next specimen
 * from an uncovered group (the diversity nudge). Suggestion prefers the biggest
 * uncovered group so priming it represents the most specimens.
 */
export function diversityStat(
  canon: PhotoRecord[],
  primedKeys: Set<string>,
): DiversityStat {
  const groups = new Map<string, PhotoRecord[]>()
  for (const r of canon) {
    const k = groupKey(r)
    const arr = groups.get(k)
    if (arr) arr.push(r)
    else groups.set(k, [r])
  }

  const covered = new Set<string>()
  for (const r of canon) {
    if (primedKeys.has(r.recordKey)) covered.add(groupKey(r))
  }

  let suggestion: PhotoRecord | null = null
  let bestSize = 0
  for (const [k, members] of groups) {
    if (covered.has(k)) continue
    const candidate = members.find((m) => !primedKeys.has(m.recordKey))
    if (candidate && members.length > bestSize) {
      bestSize = members.length
      suggestion = candidate
    }
  }

  return { totalGroups: groups.size, coveredGroups: covered.size, suggestion }
}
