import { useEffect, useState } from "react"
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  Loader2Icon,
  RedoIcon,
  SaveIcon,
  ScanSearchIcon,
  UndoIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { CropBox, type CropRect } from "@/konva/CropBox"
import { AnchorPath } from "@/konva/AnchorPath"
import { RotationPuck } from "@/konva/RotationPuck"
import { useEditorStore } from "@/state/useEditorStore"
import { primeImageUrl, usePrimeSegment } from "@/api/exemplars"
import type { PhotoRecord, Point } from "@/types/domain"

/** The materials a completed wizard hands back — the box-frame save contract shared by
 *  Prime's exemplar PUT and Review's refine POST (both take crop + angle + box anchors). */
export interface EditorSavePayload {
  recordKey: string
  cropBox: { x1: number; y1: number; x2: number; y2: number; source: "manual" }
  angleDeg: number
  anchorPath: Point[]
}

interface EditorWizardProps {
  seriesKey: string
  record: PhotoRecord
  /** Dialog title, e.g. "Prime ABC 49775" or "Refine ABC 49775". */
  title: string
  /** Prefill box + angle when re-editing an existing specimen (masking always restarts). */
  initialBox: CropRect | null
  initialAngle: number
  /** Save-button label, e.g. "Save exemplar" / "Save changes". */
  saveLabel: string
  saving: boolean
  onSave: (payload: EditorSavePayload) => void
  onClose: () => void
}

type Step = "crop" | "mask" | "orient"

const STEP_META: Record<Step, { n: number; label: string; hint: string }> = {
  crop: {
    n: 1,
    label: "Crop",
    hint: "Draw a loose box around just the target specimen — exclude any scale card or clutter. This box is both the crop and the SAM prompt.",
  },
  mask: {
    n: 2,
    label: "Mask",
    hint: "SAM traced the specimen. Drag anchors to refine · click the curve to add · ⌥-click to remove.",
  },
  orient: {
    n: 3,
    label: "Orient",
    hint: "Rotate the specimen to a consistent, upright orientation. This teaches the pipeline which way is “up” for shapes like this one.",
  },
}

/**
 * The guided box-frame editor flow (crop-before-orient), shared verbatim by Stage 2
 * (Prime) and Stage 4 (Review refine): draw a raw-frame box → SAM box-predict inside
 * it → refine the mask → set the display angle → Save.
 *
 * Reuses the three Konva editors (CropBox, AnchorPath, RotationPuck) and the anchor
 * editor's undo/redo store. Masking happens in the box (un-rotated) frame — SAM's
 * output is already box-relative, so there is zero coordinate math on the client; the
 * backend rotates the outline into the upright frame on Save from the angle set here.
 * (Orient is sequenced after Mask because the mask is edited un-rotated: EFA is
 * rotation-invariant, so mask quality is identical, and it avoids ever needing a
 * rotated-crop image endpoint.) The only difference between the two callers is where
 * the payload lands — `onSave` decides (exemplars.json vs crop/orient/mask).
 */
export function EditorWizard({
  seriesKey,
  record,
  title,
  initialBox,
  initialAngle,
  saveLabel,
  saving,
  onSave,
  onClose,
}: EditorWizardProps) {
  const recordKey = record.recordKey

  const [step, setStep] = useState<Step>("crop")
  const [box, setBox] = useState<CropRect | null>(initialBox)
  const [angleDeg, setAngleDeg] = useState<number>(initialAngle)

  const anchors = useEditorStore((s) => s.anchors)
  const activeKey = useEditorStore((s) => s.recordKey)
  const canUndo = useEditorStore((s) => s.past.length > 0)
  const canRedo = useEditorStore((s) => s.future.length > 0)
  const loadSession = useEditorStore((s) => s.loadSession)
  const clearSession = useEditorStore((s) => s.clearSession)
  const beginEdit = useEditorStore((s) => s.beginEdit)
  const setAnchors = useEditorStore((s) => s.setAnchors)
  const undo = useEditorStore((s) => s.undo)
  const redo = useEditorStore((s) => s.redo)

  const segment = usePrimeSegment(seriesKey)

  // Tear the editor session down when the wizard unmounts (a fresh one starts on
  // the next Segment). Cmd-Z / Cmd-Shift-Z traverse the mask edit history.
  useEffect(() => () => clearSession(), [clearSession])
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey
      if (!mod || e.key.toLowerCase() !== "z") return
      if (step !== "mask") return
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [undo, redo, step])

  const rawUrl = `/photos/${encodeURIComponent(seriesKey)}/${encodeURIComponent(record.filename)}`
  const maskReady = activeKey === recordKey && anchors.length >= 3

  function runSegment(next: Step) {
    if (!box) return
    segment.mutate(
      { recordKey, box: { x1: box.x1, y1: box.y1, x2: box.x2, y2: box.y2, source: "manual" } },
      {
        onSuccess: (res) => {
          loadSession(recordKey, res.anchorPath, res.anchorPath)
          setStep(next)
        },
      },
    )
  }

  function handleSave() {
    if (!box || !maskReady) return
    onSave({
      recordKey,
      cropBox: { x1: box.x1, y1: box.y1, x2: box.x2, y2: box.y2, source: "manual" },
      angleDeg,
      anchorPath: anchors,
    })
  }

  const cropUrl = box ? primeImageUrl(seriesKey, recordKey, box) : ""
  const meta = STEP_META[step]

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl gap-4">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <span className="truncate">{title}</span>
            <StepDots step={step} />
          </DialogTitle>
          <DialogDescription>
            Step {meta.n} of 3 — <span className="font-medium text-foreground">{meta.label}</span>.{" "}
            {meta.hint}
          </DialogDescription>
        </DialogHeader>

        {/* Editor surface */}
        <div className="flex min-h-[420px] items-center justify-center rounded-lg border border-border bg-muted/30 p-3">
          {step === "crop" && (
            <CropBox
              imageUrl={rawUrl}
              angleDeg={0}
              box={box}
              onChange={setBox}
              maxViewport={460}
            />
          )}

          {step === "mask" &&
            (maskReady ? (
              <AnchorPath
                imageUrl={cropUrl}
                anchors={anchors}
                maxViewport={420}
                interactive
                onEditStart={beginEdit}
                onAnchorsChange={setAnchors}
              />
            ) : (
              <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
                <Loader2Icon className="size-5 animate-spin" />
                Segmenting the specimen with SAM…
              </div>
            ))}

          {step === "orient" && (
            <RotationPuck imageUrl={cropUrl} angleDeg={angleDeg} onChange={setAngleDeg} size={360} />
          )}
        </div>

        {/* Controls */}
        <div className="flex items-center gap-2">
          {step === "crop" && (
            <>
              <div className="flex-1 text-xs text-muted-foreground">
                {box ? "Adjust the 8 handles to frame the specimen." : "Loading photo…"}
              </div>
              <Button onClick={() => runSegment("mask")} disabled={!box || segment.isPending} className="gap-1.5">
                {segment.isPending ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : (
                  <ScanSearchIcon className="size-4" />
                )}
                Segment & continue
                <ChevronRightIcon className="size-4" />
              </Button>
            </>
          )}

          {step === "mask" && (
            <>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setStep("crop")}>
                <ChevronLeftIcon className="size-4" />
                Crop
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                onClick={undo}
                disabled={!canUndo}
                title="Undo (⌘Z)"
              >
                <UndoIcon className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                onClick={redo}
                disabled={!canRedo}
                title="Redo (⌘⇧Z)"
              >
                <RedoIcon className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5"
                onClick={() => runSegment("mask")}
                disabled={segment.isPending}
                title="Re-run SAM on this box"
              >
                <ScanSearchIcon className="size-4" />
                Re-run SAM
              </Button>
              <span className="ml-1 tabular-nums text-xs text-muted-foreground">
                {maskReady ? `${anchors.length} anchors` : "—"}
              </span>
              <div className="flex-1" />
              <Button className="gap-1.5" onClick={() => setStep("orient")} disabled={!maskReady}>
                Orient
                <ChevronRightIcon className="size-4" />
              </Button>
            </>
          )}

          {step === "orient" && (
            <>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setStep("mask")}>
                <ChevronLeftIcon className="size-4" />
                Mask
              </Button>
              <span className="ml-1 tabular-nums text-xs text-muted-foreground">
                {Math.round(angleDeg)}° · drag the ring · Shift snaps 15°
              </span>
              <div className="flex-1" />
              <Button className="gap-1.5" onClick={handleSave} disabled={!maskReady || saving}>
                {saving ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : (
                  <SaveIcon className="size-4" />
                )}
                {saveLabel}
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Three progress dots for the crop → mask → orient steps. */
function StepDots({ step }: { step: Step }) {
  const order: Step[] = ["crop", "mask", "orient"]
  const activeIdx = order.indexOf(step)
  return (
    <span className="flex items-center gap-1.5" aria-hidden>
      {order.map((s, i) => (
        <span
          key={s}
          className={
            "size-2 rounded-full " +
            (i === activeIdx ? "bg-primary" : i < activeIdx ? "bg-primary/50" : "bg-muted")
          }
        />
      ))}
    </span>
  )
}
