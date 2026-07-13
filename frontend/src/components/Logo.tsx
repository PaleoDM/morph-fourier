/**
 * Morph-Fourier mark: an "MF" monogram (Arial Bold, the F merged into the M's
 * right edge) with a landmark point on every node of its outline — the app's own
 * name run through the pipeline. Teal letterforms; the outline and points use the
 * theme's foreground color so the mark stays legible in both light and dark.
 */
const POINTS: [number, number][] = [
  [9, 61], [18.75, 61], [18.75, 20.07], [29.04, 61], [39.15, 61], [48.76, 22.88],
  [48.76, 61], [59.26, 61], [59.26, 38.9], [80.97, 38.9], [80.97, 30.11],
  [59.26, 30.11], [59.26, 17.8], [84.41, 17.8], [84.41, 9], [43.48, 9],
  [34.15, 44.47], [24.71, 9], [9, 9],
]

export function Logo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 93.41 70"
      className={className}
      role="img"
      aria-label="Morph-Fourier"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M145 0H420V1154L710 0H995L1266 1074.69V0H1562V623H2174V871H1562V1218H2271V1466H1117L854 466L588 1466H145Z"
        transform="translate(3.857,61) scale(0.03547066848567531,-0.03547066848567531)"
        fill="var(--primary)"
        stroke="var(--foreground)"
        strokeWidth="24"
        strokeLinejoin="round"
      />
      <g fill="var(--foreground)">
        {POINTS.map(([cx, cy], i) => (
          <circle key={i} cx={cx} cy={cy} r="2.15" />
        ))}
      </g>
    </svg>
  )
}
