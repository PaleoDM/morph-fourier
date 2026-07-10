import type { Point } from "@/types/domain"

/** One plotted specimen: its PC scores joined with its taxonomy metadata. */
export interface PlotSpecimen {
  id: string // specimenIdSafe (join key)
  specimenId: string // human-readable
  scores: number[] // [component] — 0-based; PC k is scores[k-1]
  metadata: Record<string, string | number | null>
}

/** Fraction of the shape's larger dimension added as margin around an outline viewBox. */
const PAD_FRAC = 0.06

/**
 * Frame a closed outline for `OutlineSvg`: an SVG points string + a viewBox that is
 * the outline's own padded bounding box, so the shape fills its cell regardless of
 * where it sat in coefficient space. Mirrors the Stage-5 gallery framing.
 */
export function frameOutline(
  outline: Point[],
): { points: string; viewBox: string } | null {
  if (outline.length < 3) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of outline) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  const w = maxX - minX
  const h = maxY - minY
  if (!(w > 0) || !(h > 0)) return null
  const pad = Math.max(w, h) * PAD_FRAC
  const points = outline.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ")
  const viewBox = `${minX - pad} ${minY - pad} ${w + 2 * pad} ${h + 2 * pad}`
  return { points, viewBox }
}
