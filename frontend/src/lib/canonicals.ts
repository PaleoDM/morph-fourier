// The Orient stage (and every stage after it) operates only on the canonical
// working set: one accepted+canonical photo per specimen (ROADMAP §6). We derive
// it client-side by intersecting the parsed records with the curation decisions,
// mirroring the backend's `deps.canonical_record_keys`.

import type { CurationState, PhotoRecord } from "@/types/domain"

/** Records the user marked canonical (accepted && isCanonical), in record order. */
export function canonicalRecords(
  records: PhotoRecord[],
  curation: CurationState | undefined,
): PhotoRecord[] {
  const photos = curation?.photos ?? {}
  return records.filter((r) => {
    const d = photos[r.recordKey]
    return d?.isCanonical && d.status === "accepted"
  })
}
