// Review status + flagged-first ordering (Phase 11D).
//
// Maps an auto-result (auto_results.json) + whether an outline exists into the chip
// a specimen wears in the Review grid and the rank that sorts flagged specimens to
// the front. The flag explanation joins the 2-bucket `flagReason` (why it's flagged)
// with the specific `flagDetail` (the 11A internal reason) into human text.

import type { AutoResult } from "@/types/domain"

export type ReviewTone = "success" | "auto" | "warning" | "destructive" | "muted"

export interface ReviewStatus {
  label: string
  tone: ReviewTone
  detail: string | null // the flag explanation (flagged specimens only)
}

/** The 11A internal `flagDetail` codes → the sentence Review shows under a flagged thumb. */
const FLAG_DETAIL_TEXT: Record<string, string> = {
  no_bone_colour: "No bone-coloured region stood out from the background.",
  warm_background: "A warm background looked like bone — the box grabbed the surface.",
  low_sam_score: "SAM couldn’t isolate a clean bone in the detected box.",
  scale_card: "The largest region looked like the scale card, not a bone.",
  segmentation_failed: "Segmentation failed on this photo.",
}

export function reviewStatus(result: AutoResult | undefined, hasMask: boolean): ReviewStatus {
  if (!result) {
    return hasMask
      ? { label: "Ready", tone: "muted", detail: null }
      : { label: "Not processed", tone: "muted", detail: null }
  }
  if (result.flagged) {
    const detail = result.flagDetail
      ? FLAG_DETAIL_TEXT[result.flagDetail] ?? result.flagDetail
      : null
    return result.flagReason === "detection_failed"
      ? {
          label: "Detection failed",
          tone: "destructive",
          detail: detail ?? "The target bone couldn’t be isolated automatically.",
        }
      : {
          label: "Low confidence",
          tone: "warning",
          detail: detail ?? "The nearest exemplar match was weak — check the shape.",
        }
  }
  switch (result.source) {
    case "primed":
      return { label: "Primed", tone: "success", detail: null }
    case "manual":
      return { label: "Refined", tone: "success", detail: null }
    default:
      return { label: "Auto", tone: "auto", detail: null }
  }
}

/**
 * Sort key — smaller = surfaces first. Flagged specimens lead (detection failures
 * ahead of low-confidence, since they have no outline at all), then canonicals that
 * were never processed, then everything settled (auto-matched / primed / refined).
 */
export function reviewRank(result: AutoResult | undefined, hasMask: boolean): number {
  if (result?.flagged) return result.flagReason === "detection_failed" ? 0 : 1
  if (!result && !hasMask) return 2
  return 3
}
