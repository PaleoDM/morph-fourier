// The crop coordinate frame (ROADMAP §Phase 5, "Known Risks").
//
// The backend's `compute_crop_for_photo` does `raw.rotate(angleDeg, expand=True)`
// — PIL grows the canvas to the bounding box of the rotated image — then segments
// and returns the mask bbox in THAT rotated-and-expanded pixel space. Every crop
// box {x1,y1,x2,y2} persisted by Stage 3 lives in the same frame, and Stage 4 will
// crop the identically-rotated image with it. So `CropBox.tsx` must reproduce that
// frame exactly: rotate the raw photo by `-angleDeg` (Konva is CW-positive; the
// stored angle is CCW/PIL) about its centre, and size the stage to the expanded
// dimensions computed here.
//
// `expandedFrame` is a line-for-line port of PIL's `Image.rotate(expand=True)`
// output-size math (Pillow `Image.py`): transform the four corners by the same
// centre-baked rotation matrix, then `ceil(max) - floor(min)` per axis. Verified
// pixel-exact against PIL across 0/15/37/90/123.4/180/270/−42° on a real 3024×4032
// dorsal photo before this file was written — do not "simplify" it to
// `w|cos|+h|sin|`, which drops PIL's ceil/floor rounding and drifts by ±1px.

export interface ExpandedFrame {
  /** Width of the rotated-and-expanded canvas, in pixels (PIL's `nw`). */
  width: number
  /** Height of the rotated-and-expanded canvas, in pixels (PIL's `nh`). */
  height: number
}

/** Round to 15 decimals, matching PIL's `round(cos/sin, 15)` on the matrix. */
function round15(x: number): number {
  return Math.round(x * 1e15) / 1e15
}

/**
 * Expanded canvas size for `rawW×rawH` rotated by `angleDeg` (degrees CCW — the
 * Orient/backend convention). Mirrors `PIL.Image.rotate(angleDeg, expand=True)`.
 */
export function expandedFrame(
  rawW: number,
  rawH: number,
  angleDeg: number,
): ExpandedFrame {
  // PIL builds the matrix from `angle_rad = -radians(angle)`.
  const a = (-angleDeg * Math.PI) / 180
  const cos = round15(Math.cos(a))
  const sin = round15(Math.sin(a))
  const cx = rawW / 2
  const cy = rawH / 2
  // Matrix [cos, sin, tx, -sin, cos, ty] with the rotation centre mapped to itself.
  const tx = cos * -cx + sin * -cy + cx
  const ty = -sin * -cx + cos * -cy + cy
  const corners: [number, number][] = [
    [0, 0],
    [rawW, 0],
    [rawW, rawH],
    [0, rawH],
  ]
  const xs = corners.map(([x, y]) => cos * x + sin * y + tx)
  const ys = corners.map(([x, y]) => -sin * x + cos * y + ty)
  return {
    width: Math.ceil(Math.max(...xs)) - Math.floor(Math.min(...xs)),
    height: Math.ceil(Math.max(...ys)) - Math.floor(Math.min(...ys)),
  }
}
