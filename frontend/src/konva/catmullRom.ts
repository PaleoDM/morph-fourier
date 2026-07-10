// Closed centripetal Catmull-Rom sampler — the display twin of the backend's
// `processing.catmull_rom_closed`. The anchor editor renders the smooth outline
// by sampling this spline through the working anchors and drawing it as a plain
// closed Konva line (NOT Konva's built-in `tension`, which is a uniform cardinal
// spline that diverges from the saved authority on unevenly-spaced anchors).
//
// Centripetal parameterization (alpha = 0.5) matches the backend exactly; both
// sides therefore trace the same closed curve through the same anchors. Minor
// sub-pixel differences from the sample density are expected and harmless — the
// backend owns the authoritative arc-length resample written to the outline CSV.

export interface Pt {
  x: number
  y: number
}

const EPS = 1e-9

function knotDelta(a: Pt, b: Pt, alpha: number): number {
  const d = Math.hypot(b.x - a.x, b.y - a.y) ** alpha
  return d > EPS ? d : EPS
}

/**
 * Sample a closed centripetal Catmull-Rom spline through `anchors`.
 *
 * Returns `anchors.length * samplesPerSeg` points tracing the closed curve,
 * ready to feed a `<Line closed points={…} />`. With fewer than 3 anchors there
 * is no closed curve, so the anchors are returned as-is.
 */
export function sampleClosedCatmullRom(
  anchors: Pt[],
  samplesPerSeg = 24,
  alpha = 0.5,
): Pt[] {
  const n = anchors.length
  if (n < 3) return anchors.slice()

  const out: Pt[] = []
  for (let i = 0; i < n; i++) {
    const p0 = anchors[(i - 1 + n) % n]
    const p1 = anchors[i]
    const p2 = anchors[(i + 1) % n]
    const p3 = anchors[(i + 2) % n]

    const t0 = 0
    const t1 = t0 + knotDelta(p0, p1, alpha)
    const t2 = t1 + knotDelta(p1, p2, alpha)
    const t3 = t2 + knotDelta(p2, p3, alpha)

    for (let j = 0; j < samplesPerSeg; j++) {
      // t sweeps [t1, t2) — endpoint excluded so the next segment starts exactly
      // on the next anchor with no duplicate vertex.
      const t = t1 + ((t2 - t1) * j) / samplesPerSeg
      const a1x = ((t1 - t) / (t1 - t0)) * p0.x + ((t - t0) / (t1 - t0)) * p1.x
      const a1y = ((t1 - t) / (t1 - t0)) * p0.y + ((t - t0) / (t1 - t0)) * p1.y
      const a2x = ((t2 - t) / (t2 - t1)) * p1.x + ((t - t1) / (t2 - t1)) * p2.x
      const a2y = ((t2 - t) / (t2 - t1)) * p1.y + ((t - t1) / (t2 - t1)) * p2.y
      const a3x = ((t3 - t) / (t3 - t2)) * p2.x + ((t - t2) / (t3 - t2)) * p3.x
      const a3y = ((t3 - t) / (t3 - t2)) * p2.y + ((t - t2) / (t3 - t2)) * p3.y
      const b1x = ((t2 - t) / (t2 - t0)) * a1x + ((t - t0) / (t2 - t0)) * a2x
      const b1y = ((t2 - t) / (t2 - t0)) * a1y + ((t - t0) / (t2 - t0)) * a2y
      const b2x = ((t3 - t) / (t3 - t1)) * a2x + ((t - t1) / (t3 - t1)) * a3x
      const b2y = ((t3 - t) / (t3 - t1)) * a2y + ((t - t1) / (t3 - t1)) * a3y
      out.push({
        x: ((t2 - t) / (t2 - t1)) * b1x + ((t - t1) / (t2 - t1)) * b2x,
        y: ((t2 - t) / (t2 - t1)) * b1y + ((t - t1) / (t2 - t1)) * b2y,
      })
    }
  }
  return out
}

/** Flatten sampled points to the `[x0,y0,x1,y1,…]` array Konva `Line` expects. */
export function toFlatPoints(pts: Pt[]): number[] {
  const flat = new Array<number>(pts.length * 2)
  for (let i = 0; i < pts.length; i++) {
    flat[i * 2] = pts[i].x
    flat[i * 2 + 1] = pts[i].y
  }
  return flat
}

/**
 * Closest point on segment AB to P, and the squared distance to it. Used by the
 * editor to decide where a "click on the curve to add an anchor" lands.
 */
export function closestOnSegment(
  p: Pt,
  a: Pt,
  b: Pt,
): { point: Pt; distSq: number } {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const lenSq = abx * abx + aby * aby
  let t = lenSq > 0 ? ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq : 0
  t = Math.max(0, Math.min(1, t))
  const point = { x: a.x + t * abx, y: a.y + t * aby }
  const dx = p.x - point.x
  const dy = p.y - point.y
  return { point, distSq: dx * dx + dy * dy }
}
