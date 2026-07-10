// RotationPuck — direct-manipulation rotation (ROADMAP §Phase 4 step 1).
//
// Renders a source photo as a Konva Image rotated about its center, wrapped in a
// draggable ring "puck": grab the handle, drag around the ring, and the specimen
// rotates live. Holding Shift snaps to 15° increments (so 90° is reachable too).
// Emits `onChange(angleDeg)` where angleDeg is degrees CCW — the backend's
// `Orientation.angleDeg` convention (PIL/cv2 positive = counter-clockwise).
//
// Frame-agnostic and reusable: it knows nothing about specimens or the API. The
// image is display-downscaled to fit; nothing is written here.

import { useMemo, useRef } from "react"
import { Circle, Group, Image as KonvaImage, Layer, Line, Stage } from "react-konva"
import useImage from "use-image"
import type Konva from "konva"

interface RotationPuckProps {
  /** Source photo URL (served raw by the backend `/photos/...`). */
  imageUrl: string
  /** Current rotation to apply, degrees CCW (backend convention). */
  angleDeg: number
  /** Fired live on every drag step, with the new degrees-CCW angle (local preview). */
  onChange: (angleDeg: number) => void
  /** Fired once on release — the moment to persist (avoids a PUT per drag step). */
  onCommit?: (angleDeg: number) => void
  /** Square canvas edge in px (default 320). */
  size?: number
  /** Snap increment (deg) while Shift is held (default 15). */
  snapDeg?: number
}

/** Wrap to [0, 360). */
function norm360(deg: number): number {
  return ((deg % 360) + 360) % 360
}

/**
 * Konva rotates clockwise for positive `rotation`; the backend stores degrees
 * CCW. So the on-screen Konva rotation of the image is `-angleDeg`, and the ring
 * handle — anchored at the specimen's "up" — sits at screen angle `-90 - angleDeg`.
 */
export function RotationPuck({
  imageUrl,
  angleDeg,
  onChange,
  onCommit,
  size = 320,
  snapDeg = 15,
}: RotationPuckProps) {
  const [image, status] = useImage(imageUrl, "anonymous")
  const handleRef = useRef<Konva.Circle>(null)

  const center = size / 2
  const ringRadius = size * 0.44
  const handleRadius = 11

  // Fit the image inside the ring so it never clips as it spins: its longest side
  // must fit within the ring's inner circle (diameter = 2 * inner). One uniform
  // scale about the natural-pixel center preserves aspect ratio.
  const fitScale = useMemo(() => {
    if (!image) return null
    const inner = ringRadius - handleRadius - 6
    const longest = Math.max(image.width, image.height) || 1
    return (inner * 2) / longest
  }, [image, ringRadius])

  // Handle position on the ring, derived from the current angle (controlled).
  const handleScreenRad = ((-90 - angleDeg) * Math.PI) / 180
  const handleX = center + ringRadius * Math.cos(handleScreenRad)
  const handleY = center + ringRadius * Math.sin(handleScreenRad)

  /** Pointer (x,y) relative to center → degrees-CCW angle, snapping under Shift. */
  function angleFromPoint(x: number, y: number, shift: boolean): number {
    const phi = Math.atan2(y - center, x - center) // screen radians, y-down (CW+)
    let deg = -(( phi * 180) / Math.PI + 90) // invert to CCW, offset the "up" anchor
    deg = norm360(deg)
    if (shift) deg = Math.round(deg / snapDeg) * snapDeg
    return norm360(deg)
  }

  function handleDrag(e: Konva.KonvaEventObject<DragEvent>) {
    const node = e.target
    const shift = !!(e.evt as unknown as MouseEvent)?.shiftKey
    onChange(angleFromPoint(node.x(), node.y(), shift))
  }

  function handleDragEnd(e: Konva.KonvaEventObject<DragEvent>) {
    const node = e.target
    const shift = !!(e.evt as unknown as MouseEvent)?.shiftKey
    const deg = angleFromPoint(node.x(), node.y(), shift)
    onChange(deg)
    onCommit?.(deg)
    const stage = node.getStage()
    if (stage) stage.container().style.cursor = "grab"
  }

  // Keep the dragged handle pinned to the ring (radius-locked), whatever the pointer.
  function dragBound(pos: Konva.Vector2d): Konva.Vector2d {
    const dx = pos.x - center
    const dy = pos.y - center
    const len = Math.hypot(dx, dy) || 1
    return {
      x: center + (dx / len) * ringRadius,
      y: center + (dy / len) * ringRadius,
    }
  }

  return (
    <Stage width={size} height={size}>
      <Layer listening>
        {/* Track ring */}
        <Circle
          x={center}
          y={center}
          radius={ringRadius}
          stroke="#94a3b8"
          strokeWidth={2}
          dash={[4, 5]}
        />
        {/* The rotated specimen */}
        {image && fitScale && (
          <KonvaImage
            image={image}
            x={center}
            y={center}
            offsetX={image.width / 2}
            offsetY={image.height / 2}
            scaleX={fitScale}
            scaleY={fitScale}
            rotation={-angleDeg}
            listening={false}
          />
        )}
        {/* Spoke from center to the handle (the "up" indicator) */}
        <Line
          points={[center, center, handleX, handleY]}
          stroke="#6366f1"
          strokeWidth={2}
        />
        {/* Draggable handle */}
        <Group>
          <Circle
            ref={handleRef}
            x={handleX}
            y={handleY}
            radius={handleRadius}
            fill="#6366f1"
            stroke="#ffffff"
            strokeWidth={2}
            shadowColor="#000000"
            shadowOpacity={0.25}
            shadowBlur={4}
            draggable
            dragBoundFunc={dragBound}
            onDragMove={handleDrag}
            onDragEnd={handleDragEnd}
            onMouseEnter={(e) => {
              const stage = e.target.getStage()
              if (stage) stage.container().style.cursor = "grab"
            }}
            onMouseDown={(e) => {
              const stage = e.target.getStage()
              if (stage) stage.container().style.cursor = "grabbing"
            }}
            onMouseLeave={(e) => {
              const stage = e.target.getStage()
              if (stage) stage.container().style.cursor = "default"
            }}
          />
        </Group>
      </Layer>
      {status === "failed" && (
        <Layer listening={false}>
          <Line points={[center - 40, center, center + 40, center]} stroke="#ef4444" />
        </Layer>
      )}
    </Stage>
  )
}
