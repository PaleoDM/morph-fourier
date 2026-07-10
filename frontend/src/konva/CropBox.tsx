// CropBox — direct-manipulation crop rectangle (ROADMAP §Phase 5 step 1).
//
// Renders the raw photo rotated into the backend's rotated-AND-expanded frame
// (see `expand.ts`) with an 8-handle bounding box over it: 4 corners + 4 edge
// midpoints. Dragging any handle mutates `{x1,y1,x2,y2}` live; handles are
// clamped to the image bounds and can't cross (the box can neither invert nor
// escape). Everything outside the box is dimmed.
//
// The box is expressed and emitted in EXPANDED-FRAME pixels — the same space the
// backend persists and Stage 4 crops. Internally we render at a display scale
// (`viewScale`) that fits the editor viewport, converting frame↔display only for
// drawing and drag math; nothing display-space ever leaves the component.
//
// Frame-agnostic and reusable: it knows nothing about specimens, series, or the
// API. Colours are literal (Konva paints canvas, not DOM) and mirror
// `RotationPuck`'s indigo/slate palette for cross-editor consistency.

import { useEffect, useMemo, useRef } from "react"
import { Group, Image as KonvaImage, Layer, Rect, Stage } from "react-konva"
import useImage from "use-image"
import type Konva from "konva"

import { expandedFrame } from "@/konva/expand"

/** A crop rectangle in expanded-frame pixels (matches the persisted `CropBox`). */
export interface CropRect {
  x1: number
  y1: number
  x2: number
  y2: number
}

interface CropBoxProps {
  /** Source photo URL (served raw by the backend `/photos/...`). */
  imageUrl: string
  /** Stage-2 rotation to apply, degrees CCW (backend/Orient convention). */
  angleDeg: number
  /** Current box in expanded-frame pixels, or `null` to seed a centred default. */
  box: CropRect | null
  /** Fired live on every drag step (and once to seed a default box). */
  onChange: (box: CropRect) => void
  /** Fired once on release — the moment to persist (avoids a PUT per drag step). */
  onCommit?: (box: CropRect) => void
  /** Longest display edge in px (default 520). The frame is scaled to fit this. */
  maxViewport?: number
  /** Read-only preview (thumbnails): draw the box, no handles, no interaction. */
  interactive?: boolean
}

const HANDLE = 9 // half-size of a handle square, in display px
const MIN_FRAME = 12 // smallest allowed box edge, in frame px (no-invert floor)

// The 8 handles, each tagged with which edges it moves. "" = that axis is free
// (an edge-midpoint follows the box's current mid on the free axis).
type Horiz = "l" | "r" | ""
type Vert = "t" | "b" | ""
const HANDLES: { id: string; h: Horiz; v: Vert }[] = [
  { id: "tl", h: "l", v: "t" },
  { id: "tm", h: "", v: "t" },
  { id: "tr", h: "r", v: "t" },
  { id: "ml", h: "l", v: "" },
  { id: "mr", h: "r", v: "" },
  { id: "bl", h: "l", v: "b" },
  { id: "bm", h: "", v: "b" },
  { id: "br", h: "r", v: "b" },
]

export function CropBox({
  imageUrl,
  angleDeg,
  box,
  onChange,
  onCommit,
  maxViewport = 520,
  interactive = true,
}: CropBoxProps) {
  const [image, status] = useImage(imageUrl, "anonymous")

  // Expanded (rotated) frame + the display scale that fits it into the viewport.
  const frame = useMemo(
    () => (image ? expandedFrame(image.width, image.height, angleDeg) : null),
    [image, angleDeg],
  )
  const viewScale = frame
    ? Math.min(maxViewport / frame.width, maxViewport / frame.height)
    : 1
  const stageW = frame ? frame.width * viewScale : maxViewport
  const stageH = frame ? frame.height * viewScale : maxViewport

  // Seed a centred 60%-of-frame default the first time we have a frame but no box
  // (interactive editor only — a read-only thumbnail with no crop shows no box).
  useEffect(() => {
    if (!frame || box || !interactive) return
    const mx = frame.width * 0.2
    const my = frame.height * 0.2
    onChange({
      x1: mx,
      y1: my,
      x2: frame.width - mx,
      y2: frame.height - my,
    })
  }, [frame, box, interactive, onChange])

  // frame px → display px and back.
  const toDisp = (v: number) => v * viewScale
  const toFrame = (v: number) => v / viewScale

  // Latest box in a ref so drag handlers read live edges without stale closures.
  const boxRef = useRef<CropRect | null>(box)
  boxRef.current = box

  function clampFrameBox(b: CropRect): CropRect {
    if (!frame) return b
    const x1 = Math.min(Math.max(0, b.x1), frame.width - MIN_FRAME)
    const y1 = Math.min(Math.max(0, b.y1), frame.height - MIN_FRAME)
    const x2 = Math.max(Math.min(frame.width, b.x2), x1 + MIN_FRAME)
    const y2 = Math.max(Math.min(frame.height, b.y2), y1 + MIN_FRAME)
    return { x1, y1, x2, y2 }
  }

  function applyHandle(
    h: Horiz,
    v: Vert,
    dispX: number,
    dispY: number,
  ): CropRect {
    const cur = boxRef.current
    if (!cur || !frame) return cur ?? { x1: 0, y1: 0, x2: 0, y2: 0 }
    const fx = toFrame(dispX)
    const fy = toFrame(dispY)
    let { x1, y1, x2, y2 } = cur
    // Move the dragged edge, clamping against the opposite edge (no invert).
    if (h === "l") x1 = Math.min(fx, x2 - MIN_FRAME)
    else if (h === "r") x2 = Math.max(fx, x1 + MIN_FRAME)
    if (v === "t") y1 = Math.min(fy, y2 - MIN_FRAME)
    else if (v === "b") y2 = Math.max(fy, y1 + MIN_FRAME)
    return clampFrameBox({ x1, y1, x2, y2 })
  }

  function onHandleDrag(
    h: Horiz,
    v: Vert,
    e: Konva.KonvaEventObject<DragEvent>,
  ) {
    const node = e.target
    onChange(applyHandle(h, v, node.x(), node.y()))
  }

  function onHandleDragEnd(
    h: Horiz,
    v: Vert,
    e: Konva.KonvaEventObject<DragEvent>,
  ) {
    const node = e.target
    const next = applyHandle(h, v, node.x(), node.y())
    onChange(next)
    onCommit?.(next)
    const stage = node.getStage()
    if (stage) stage.container().style.cursor = "default"
  }

  // Cursor per handle role (corner nwse/nesw, edge ns/ew).
  function cursorFor(h: Horiz, v: Vert): string {
    if (h && v) {
      const nwse = (h === "l" && v === "t") || (h === "r" && v === "b")
      return nwse ? "nwse-resize" : "nesw-resize"
    }
    return h ? "ew-resize" : "ns-resize"
  }

  // Display-space geometry of the current box (used for overlay + handles).
  const disp = box
    ? {
        x1: toDisp(box.x1),
        y1: toDisp(box.y1),
        x2: toDisp(box.x2),
        y2: toDisp(box.y2),
      }
    : null

  return (
    <Stage width={stageW} height={stageH} className="rounded-md">
      {/* Image layer (never listens — clicks belong to the handles). */}
      <Layer listening={false}>
        {image && frame && (
          <KonvaImage
            image={image}
            x={stageW / 2}
            y={stageH / 2}
            offsetX={image.width / 2}
            offsetY={image.height / 2}
            scaleX={viewScale}
            scaleY={viewScale}
            rotation={-angleDeg}
          />
        )}
      </Layer>

      {/* Dim + box + handles. */}
      <Layer listening={interactive}>
        {disp && (
          <>
            {/* Four dimming bands around the crop (top, bottom, left, right). */}
            <Rect x={0} y={0} width={stageW} height={disp.y1} fill="#0f172a" opacity={0.5} listening={false} />
            <Rect x={0} y={disp.y2} width={stageW} height={stageH - disp.y2} fill="#0f172a" opacity={0.5} listening={false} />
            <Rect x={0} y={disp.y1} width={disp.x1} height={disp.y2 - disp.y1} fill="#0f172a" opacity={0.5} listening={false} />
            <Rect x={disp.x2} y={disp.y1} width={stageW - disp.x2} height={disp.y2 - disp.y1} fill="#0f172a" opacity={0.5} listening={false} />

            {/* The crop rectangle. */}
            <Rect
              x={disp.x1}
              y={disp.y1}
              width={disp.x2 - disp.x1}
              height={disp.y2 - disp.y1}
              stroke="#6366f1"
              strokeWidth={2}
              listening={false}
            />

            {/* Eight handles (interactive only). */}
            {interactive && (
              <Group>
                {HANDLES.map(({ id, h, v }) => {
                  const hx = h === "l" ? disp.x1 : h === "r" ? disp.x2 : (disp.x1 + disp.x2) / 2
                  const hy = v === "t" ? disp.y1 : v === "b" ? disp.y2 : (disp.y1 + disp.y2) / 2
                  return (
                    <Rect
                      key={id}
                      // Position by CENTER (offset back by half-size) so the
                      // node's x()/y() ARE the edge coordinate. Reading the raw
                      // top-left here previously introduced a HANDLE-px offset,
                      // which made every drag frame's state→render reset the
                      // handle away from Konva's live drag position → jitter.
                      x={hx}
                      y={hy}
                      offsetX={HANDLE}
                      offsetY={HANDLE}
                      width={HANDLE * 2}
                      height={HANDLE * 2}
                      cornerRadius={2}
                      fill="#6366f1"
                      stroke="#ffffff"
                      strokeWidth={2}
                      shadowColor="#000000"
                      shadowOpacity={0.25}
                      shadowBlur={3}
                      draggable
                      // Clamp the moving axis to image bounds; lock the free axis
                      // of an edge-midpoint handle to its current mid so it can't
                      // wander off-axis (corner handles move on both axes).
                      dragBoundFunc={(pos) => ({
                        x: h === "" ? hx : Math.min(Math.max(0, pos.x), stageW),
                        y: v === "" ? hy : Math.min(Math.max(0, pos.y), stageH),
                      })}
                      onDragMove={(e) => onHandleDrag(h, v, e)}
                      onDragEnd={(e) => onHandleDragEnd(h, v, e)}
                      onMouseEnter={(e) => {
                        const stage = e.target.getStage()
                        if (stage) stage.container().style.cursor = cursorFor(h, v)
                      }}
                      onMouseLeave={(e) => {
                        const stage = e.target.getStage()
                        if (stage) stage.container().style.cursor = "default"
                      }}
                    />
                  )
                })}
              </Group>
            )}
          </>
        )}
      </Layer>

      {status === "failed" && (
        <Layer listening={false}>
          <Rect x={0} y={0} width={stageW} height={stageH} fill="#fef2f2" />
        </Layer>
      )}
    </Stage>
  )
}
