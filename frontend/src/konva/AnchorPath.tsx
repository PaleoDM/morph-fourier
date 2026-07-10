// AnchorPath — the pen-tool mask editor (ROADMAP §Phase 6 step 2).
//
// Renders the STANDARDIZED image (rotated+cropped, served by
// `GET /api/{series}/mask/{recordKey}/image`) with a closed smooth outline
// overlaid: a centripetal Catmull-Rom spline through the anchor array (the exact
// twin of the backend authority — see `konva/catmullRom.ts`). Each anchor is a
// draggable handle; clicking the curve inserts an anchor at that point;
// right-click / double-click removes one. The curve re-renders live on every
// drag step — all editing is client-side, no server round-trip.
//
// Frame-agnostic and reusable: anchor coords are the served image's own pixels,
// so there is NO coordinate math beyond a display scale-to-fit. It knows nothing
// about the store, series, or API — a controlled component driven by `anchors`
// plus two callbacks (`onEditStart` snapshots history; `onAnchorsChange` commits
// the new array). Colours are literal to match CropBox/RotationPuck (Konva paints
// canvas, not DOM).

import { useMemo } from "react"
import { Circle, Image as KonvaImage, Layer, Line, Rect, Stage } from "react-konva"
import useImage from "use-image"
import type Konva from "konva"

import {
  closestOnSegment,
  sampleClosedCatmullRom,
  toFlatPoints,
  type Pt,
} from "@/konva/catmullRom"

/** A SAM seed in served-image pixel coords. `label` 1 = positive, 0 = negative. */
export interface Seed {
  x: number
  y: number
  label: 0 | 1
}

interface AnchorPathProps {
  /** Standardized-image URL (`/api/{series}/mask/{recordKey}/image`). */
  imageUrl: string
  /** Anchor control points in the served image's pixel coords. */
  anchors: Pt[]
  /** Longest display edge in px (default 520). The image is scaled to fit this. */
  maxViewport?: number
  /** Read-only preview (thumbnails): draw the curve only, no handles, no editing. */
  interactive?: boolean
  /** Fired once at the start of a mutating gesture — the moment to snapshot undo history. */
  onEditStart?: () => void
  /** Fired with the new anchor array after a drag step, insert, or remove. */
  onAnchorsChange?: (next: Pt[]) => void

  /* ── Secondary SAM-seed workflow (fallback; primary is anchor editing) ── */
  /** When true, clicks drop SAM seeds instead of editing anchors. */
  seedMode?: boolean
  /** Seeds to render (green = positive, red = negative), in image pixel coords. */
  seeds?: Seed[]
  /** Fired when the user clicks the image in seed mode (parent assigns the label). */
  onAddSeed?: (point: Pt) => void
}

const HANDLE_R = 6 // anchor handle radius, display px
const MIN_ANCHORS = 3 // a closed curve needs at least three

export function AnchorPath({
  imageUrl,
  anchors,
  maxViewport = 520,
  interactive = true,
  onEditStart,
  onAnchorsChange,
  seedMode = false,
  seeds = [],
  onAddSeed,
}: AnchorPathProps) {
  const [image, status] = useImage(imageUrl, "anonymous")

  const viewScale = image
    ? Math.min(maxViewport / image.width, maxViewport / image.height)
    : 1
  const stageW = image ? image.width * viewScale : maxViewport
  const stageH = image ? image.height * viewScale : maxViewport

  const toDisp = (v: number) => v * viewScale
  const toFrame = (v: number) => v / viewScale

  // Anchors are editable only in the primary workflow. In seed mode the image
  // owns clicks (dropping SAM prompts) and the anchors are shown static.
  const anchorsEditable = interactive && !seedMode

  // Sampled smooth outline (image coords) → display-space flat points for Konva.
  const flatCurve = useMemo(() => {
    const sampled = sampleClosedCatmullRom(anchors)
    return toFlatPoints(sampled.map((p) => ({ x: toDisp(p.x), y: toDisp(p.y) })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchors, viewScale])

  function clampFrame(p: Pt): Pt {
    if (!image) return p
    return {
      x: Math.min(Math.max(0, p.x), image.width),
      y: Math.min(Math.max(0, p.y), image.height),
    }
  }

  function dragBound(pos: Konva.Vector2d): Konva.Vector2d {
    return {
      x: Math.min(Math.max(0, pos.x), stageW),
      y: Math.min(Math.max(0, pos.y), stageH),
    }
  }

  function moveAnchor(i: number, node: Konva.Node) {
    const next = anchors.slice()
    next[i] = clampFrame({ x: toFrame(node.x()), y: toFrame(node.y()) })
    onAnchorsChange?.(next)
  }

  function removeAnchor(i: number) {
    if (anchors.length <= MIN_ANCHORS) return
    onEditStart?.()
    onAnchorsChange?.(anchors.filter((_, idx) => idx !== i))
  }

  // Click on the curve → insert an anchor at the projected click point, between
  // the two anchors whose segment it's closest to (wrap segment included).
  function insertAt(stagePos: Konva.Vector2d) {
    if (anchors.length < 2) return
    const click: Pt = { x: toFrame(stagePos.x), y: toFrame(stagePos.y) }
    let best = { i: 0, distSq: Infinity, point: click }
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i]
      const b = anchors[(i + 1) % anchors.length]
      const { point, distSq } = closestOnSegment(click, a, b)
      if (distSq < best.distSq) best = { i, distSq, point }
    }
    onEditStart?.()
    const next = anchors.slice()
    next.splice(best.i + 1, 0, best.point)
    onAnchorsChange?.(next)
  }

  // Remove the anchor nearest a stage-space point — used by Alt-click on the
  // curve, so removal doesn't require hitting the tiny anchor dot precisely.
  function removeNearest(stagePos: Konva.Vector2d) {
    if (anchors.length <= MIN_ANCHORS) return
    const p: Pt = { x: toFrame(stagePos.x), y: toFrame(stagePos.y) }
    let best = { i: -1, distSq: Infinity }
    for (let i = 0; i < anchors.length; i++) {
      const dx = anchors[i].x - p.x
      const dy = anchors[i].y - p.y
      const d = dx * dx + dy * dy
      if (d < best.distSq) best = { i, distSq: d }
    }
    if (best.i >= 0) removeAnchor(best.i)
  }

  function onCurveClick(e: Konva.KonvaEventObject<MouseEvent>) {
    if (!anchorsEditable) return
    if (e.evt.button !== 0) return // left-click only
    const stage = e.target.getStage()
    const pos = stage?.getPointerPosition()
    if (!pos) return
    // Alt/Option-click removes the nearest anchor; a plain click inserts one.
    if (e.evt.altKey) removeNearest(pos)
    else insertAt(pos)
  }

  function onImageClick(e: Konva.KonvaEventObject<MouseEvent>) {
    if (!seedMode) return
    if (e.evt.button !== 0) return
    const stage = e.target.getStage()
    const pos = stage?.getPointerPosition()
    if (pos) onAddSeed?.(clampFrame({ x: toFrame(pos.x), y: toFrame(pos.y) }))
  }

  return (
    <Stage width={stageW} height={stageH} className="rounded-md">
      {/* Standardized image background. Listens only in seed mode (to drop seeds). */}
      <Layer listening={seedMode}>
        {image && (
          <KonvaImage
            image={image}
            width={stageW}
            height={stageH}
            onClick={onImageClick}
            onMouseEnter={(e) => {
              if (!seedMode) return
              const stage = e.target.getStage()
              if (stage) stage.container().style.cursor = "crosshair"
            }}
            onMouseLeave={(e) => {
              const stage = e.target.getStage()
              if (stage) stage.container().style.cursor = "default"
            }}
          />
        )}
      </Layer>

      {/* Outline + anchors. */}
      <Layer listening={anchorsEditable}>
        {anchors.length >= MIN_ANCHORS && (
          <>
            {/* Translucent fill so the enclosed shape reads at a glance. */}
            <Line points={flatCurve} closed fill="#6366f1" opacity={0.12} listening={false} />
            {/* The smooth outline — click a segment to insert an anchor. */}
            <Line
              points={flatCurve}
              closed
              stroke="#6366f1"
              strokeWidth={2}
              hitStrokeWidth={anchorsEditable ? 14 : 0}
              onClick={onCurveClick}
              onMouseEnter={(e) => {
                if (!anchorsEditable) return
                const stage = e.target.getStage()
                if (stage) stage.container().style.cursor = "copy"
              }}
              onMouseLeave={(e) => {
                const stage = e.target.getStage()
                if (stage) stage.container().style.cursor = "default"
              }}
            />
          </>
        )}

        {interactive &&
          anchors.map((a, i) => (
            <Circle
              key={i}
              x={toDisp(a.x)}
              y={toDisp(a.y)}
              radius={HANDLE_R}
              fill="#ffffff"
              stroke="#6366f1"
              strokeWidth={2}
              opacity={anchorsEditable ? 1 : 0.55}
              shadowColor="#000000"
              shadowOpacity={0.25}
              shadowBlur={3}
              draggable={anchorsEditable}
              dragBoundFunc={dragBound}
              onDragStart={() => onEditStart?.()}
              onDragMove={(e) => moveAnchor(i, e.target)}
              onMouseDown={(e) => {
                // Alt/Option (or ⌘) + click removes this anchor. Handled on
                // mousedown so it wins before a drag can start.
                if (anchorsEditable && (e.evt.altKey || e.evt.metaKey)) {
                  e.cancelBubble = true
                  e.evt.preventDefault()
                  removeAnchor(i)
                }
              }}
              onContextMenu={(e) => {
                e.evt.preventDefault()
                if (anchorsEditable) removeAnchor(i)
              }}
              onDblClick={() => {
                if (anchorsEditable) removeAnchor(i)
              }}
              onMouseEnter={(e) => {
                if (!anchorsEditable) return
                const stage = e.target.getStage()
                if (stage) stage.container().style.cursor = "grab"
              }}
              onMouseLeave={(e) => {
                const stage = e.target.getStage()
                if (stage) stage.container().style.cursor = "default"
              }}
            />
          ))}
      </Layer>

      {/* SAM seeds (secondary workflow): green = positive, red = negative. */}
      {seeds.length > 0 && (
        <Layer listening={false}>
          {seeds.map((s, i) => (
            <Circle
              key={i}
              x={toDisp(s.x)}
              y={toDisp(s.y)}
              radius={5}
              fill={s.label === 1 ? "#10b981" : "#ef4444"}
              stroke="#ffffff"
              strokeWidth={2}
            />
          ))}
        </Layer>
      )}

      {status === "failed" && (
        <Layer listening={false}>
          <Rect x={0} y={0} width={stageW} height={stageH} fill="#fef2f2" />
        </Layer>
      )}
    </Stage>
  )
}
