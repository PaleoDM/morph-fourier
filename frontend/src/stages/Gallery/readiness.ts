// Gallery readiness join (ROADMAP Phase 7). A canonical is "ready" for the outline
// gallery — and for export — only when all three upstream artifacts exist: a stored
// orientation (Stage 2), a crop box (Stage 3), and a saved mask outline (Stage 4).
//
// This mirrors the backend export gate exactly (backend/src/app/api/export.py), so
// the gallery's "N of M ready" count equals what Export will actually write. Anything
// short of ready is surfaced in the "missing" list with the specific stage(s) it
// lacks — never silently omitted (roadmap success criterion).

import type {
  CropState,
  MaskState,
  OrientState,
  PhotoRecord,
} from "@/types/domain"

export interface MissingSpecimen {
  record: PhotoRecord
  /** Human-readable stage labels the specimen is missing, e.g. ["Crop", "Mask"]. */
  lacks: string[]
}

export interface GalleryReadiness {
  ready: PhotoRecord[]
  missing: MissingSpecimen[]
}

/**
 * Split the canonical set into fully-ready specimens (orient + crop + mask outline)
 * and specimens missing one or more of those, in the input record order.
 */
export function galleryReadiness(
  canon: PhotoRecord[],
  orient: OrientState | undefined,
  crop: CropState | undefined,
  mask: MaskState | undefined,
): GalleryReadiness {
  const orientations = orient?.orientations ?? {}
  const crops = crop?.crops ?? {}
  const masks = mask?.masks ?? {}

  const ready: PhotoRecord[] = []
  const missing: MissingSpecimen[] = []

  for (const record of canon) {
    const rk = record.recordKey
    const lacks: string[] = []
    if (orientations[rk] == null) lacks.push("Orient")
    if (crops[rk] == null) lacks.push("Crop")
    // The outline authority is the anchorPath (matches Stage 4's masked count and
    // the backend's outline-exists check).
    if (masks[rk]?.anchorPath == null) lacks.push("Mask")

    if (lacks.length === 0) ready.push(record)
    else missing.push({ record, lacks })
  }

  return { ready, missing }
}
