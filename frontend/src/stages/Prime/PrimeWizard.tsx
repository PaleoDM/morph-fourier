import { EditorWizard } from "@/components/EditorWizard"
import { useSaveExemplar } from "@/api/exemplars"
import type { Exemplar, PhotoRecord } from "@/types/domain"

interface PrimeWizardProps {
  seriesKey: string
  record: PhotoRecord
  /** The existing exemplar when re-priming (prefills the box + angle; masking restarts). */
  existing: Exemplar | undefined
  onClose: () => void
}

/**
 * Stage 2 — Prime's per-exemplar flow: the shared box-frame {@link EditorWizard} whose
 * Save persists an :class:`Exemplar` (crop + angle + box-frame anchors) via
 * `PUT /prime/exemplar`; the backend derives the oriented outline + normalized
 * efaCoeffs. Re-priming prefills the box + angle from the existing exemplar.
 */
export function PrimeWizard({ seriesKey, record, existing, onClose }: PrimeWizardProps) {
  const save = useSaveExemplar(seriesKey)

  return (
    <EditorWizard
      seriesKey={seriesKey}
      record={record}
      title={`Prime ${record.specimenId}`}
      initialBox={
        existing
          ? {
              x1: existing.cropBox.x1,
              y1: existing.cropBox.y1,
              x2: existing.cropBox.x2,
              y2: existing.cropBox.y2,
            }
          : null
      }
      initialAngle={existing?.angleDeg ?? 0}
      saveLabel={existing ? "Re-save exemplar" : "Save exemplar"}
      saving={save.isPending}
      onSave={(payload) => save.mutate(payload, { onSuccess: () => onClose() })}
      onClose={onClose}
    />
  )
}
