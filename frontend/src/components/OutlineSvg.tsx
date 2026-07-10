// The shared SVG-outline primitive — one closed `<polygon>` sampled from a
// specimen's anchor path. Two stages draw it:
//
//   • Stage 4 (MaskThumb): overlaid on the standardized `<img>`, so its viewBox
//     is the crop frame's pixel size and it aligns anchor-for-pixel with the image.
//   • Stage 5 (OutlineThumb): shape-only on a neutral card, so its viewBox is the
//     outline's own (padded) bounding box — the shape fills the card, no image.
//
// The polygon styling is identical in both (that's the point of sharing): a faint
// fill + a non-scaling stroke so line weight stays constant on screen regardless
// of how the viewBox scales. The caller owns positioning/colour via `className`.

import { sampleClosedCatmullRom } from "@/konva/catmullRom"
import type { Point } from "@/types/domain"

/**
 * Sample a specimen's anchor path into a self-framed, shape-only polygon — the
 * "compare shapes at a glance" view shared by Stage 5 (Gallery) and Stage 4 (Review).
 *
 * Uses the same closed centripetal Catmull-Rom sampler the editor draws with, then
 * frames the result by its own (padded) bounding box so the shape fills its card
 * regardless of where it sat in the crop frame. Returns null for a degenerate path
 * (< 3 points or zero-area), which callers render as a "no outline" placeholder.
 */
export function outlineShape(
  anchorPath: Point[] | null | undefined,
  padFrac = 0.06,
): { points: string; viewBox: string } | null {
  if (!anchorPath || anchorPath.length < 3) return null
  const pts = sampleClosedCatmullRom(anchorPath)
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of pts) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  const w = maxX - minX
  const h = maxY - minY
  if (!(w > 0) || !(h > 0)) return null
  const pad = Math.max(w, h) * padFrac
  const points = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")
  const viewBox = `${minX - pad} ${minY - pad} ${w + 2 * pad} ${h + 2 * pad}`
  return { points, viewBox }
}

interface OutlineSvgProps {
  /** Sampled polygon vertices as an SVG points string ("x,y x,y …"). */
  points: string
  /** SVG viewBox — "minX minY width height" in the points' own coordinate space. */
  viewBox: string
  /** Positioning + colour (the stroke/fill use `currentColor`). */
  className?: string
  preserveAspectRatio?: string
}

export function OutlineSvg({
  points,
  viewBox,
  className,
  preserveAspectRatio = "xMidYMid meet",
}: OutlineSvgProps) {
  return (
    <svg viewBox={viewBox} preserveAspectRatio={preserveAspectRatio} className={className}>
      <polygon
        points={points}
        fill="currentColor"
        fillOpacity={0.12}
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}
