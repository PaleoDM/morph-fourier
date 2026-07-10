import { EditorWizard } from "@/components/EditorWizard"
import { useRefine } from "@/api/review"
import type { CropBox, PhotoRecord } from "@/types/domain"

interface ReviewWizardProps {
  seriesKey: string
  record: PhotoRecord
  /** The specimen's current crop box (raw frame, auto or primed) — prefills the box. */
  cropBox: CropBox | undefined
  /** The specimen's current display angle — prefills the puck. */
  angleDeg: number | undefined
  onClose: () => void
}

/**
 * Stage 4 — Review's refine flow: the same box-frame {@link EditorWizard} Prime uses,
 * but Save overwrites the specimen's crop/orient/mask geometry via `POST /review/refine`
 * (not the exemplar set) and stamps it a human, unflagged result. The current auto/primed
 * crop + angle prefill the wizard so the user starts from the machine's best guess and
 * only nudges what's wrong.
 */
export function ReviewWizard({ seriesKey, record, cropBox, angleDeg, onClose }: ReviewWizardProps) {
  const refine = useRefine(seriesKey)

  return (
    <EditorWizard
      seriesKey={seriesKey}
      record={record}
      title={`Refine ${record.specimenId}`}
      initialBox={
        cropBox ? { x1: cropBox.x1, y1: cropBox.y1, x2: cropBox.x2, y2: cropBox.y2 } : null
      }
      initialAngle={angleDeg ?? 0}
      saveLabel="Save changes"
      saving={refine.isPending}
      onSave={(payload) => refine.mutate(payload, { onSuccess: () => onClose() })}
      onClose={onClose}
    />
  )
}
