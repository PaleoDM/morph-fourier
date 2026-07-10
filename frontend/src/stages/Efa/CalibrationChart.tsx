import { useMemo } from "react"
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"

import { Button } from "@/components/ui/button"
import { DATA_PRIMARY } from "@/lib/dataviz"
import type { CalibrationResult } from "@/types/domain"

/** Recharts tooltip styling that tracks the theme tokens (no hardcoded colours). */
const TOOLTIP_STYLE = {
  background: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--popover-foreground)",
  fontSize: 12,
  padding: "6px 10px",
} as const

const PCT = (v: number) => `${(v * 100).toFixed(v >= 0.999 ? 1 : 0)}%`

interface CalibrationChartProps {
  result: CalibrationResult
  /** The current slider value, drawn as a live marker over the curve. */
  currentHarmonics: number
  /** Click a "use N" recommendation → set the harmonics slider. */
  onUseHarmonics: (n: number) => void
}

/**
 * Stage 6 calibration view. Plots the mean cumulative-power curve (fraction of
 * total shape power captured by harmonics 1..n, pooled across the masked
 * canonicals) with vertical markers at the 95 / 99 / 99.9% harmonic
 * recommendations, plus one-click "use N" buttons that drive the slider.
 */
export function CalibrationChart({
  result,
  currentHarmonics,
  onUseHarmonics,
}: CalibrationChartProps) {
  const data = useMemo(
    () => result.meanCurve.map((v, i) => ({ harmonic: i + 1, cum: v })),
    [result.meanCurve],
  )
  const recs = useMemo(
    () => [...result.recommended].sort((a, b) => a.threshold - b.threshold),
    [result.recommended],
  )

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium">Harmonic calibration</h3>
        <span className="text-xs tabular-nums text-muted-foreground">
          pooled across {result.nSpecimens} specimen
          {result.nSpecimens === 1 ? "" : "s"}
        </span>
      </div>

      <div className="mt-3 h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: -8 }}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
            <XAxis
              dataKey="harmonic"
              tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
              tickLine={{ stroke: "var(--border)" }}
              axisLine={{ stroke: "var(--border)" }}
              label={{
                value: "harmonics",
                position: "insideBottom",
                offset: -2,
                fill: "var(--muted-foreground)",
                fontSize: 11,
              }}
            />
            <YAxis
              domain={[0, 1]}
              tickFormatter={PCT}
              tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
              tickLine={{ stroke: "var(--border)" }}
              axisLine={{ stroke: "var(--border)" }}
            />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              formatter={(v) => [PCT(Number(v)), "cumulative power"]}
              labelFormatter={(h) => `harmonic ${h}`}
            />
            {recs.map((r) => (
              <ReferenceLine
                key={r.threshold}
                x={r.harmonics}
                stroke="var(--muted-foreground)"
                strokeDasharray="4 3"
                label={{
                  value: PCT(r.threshold),
                  position: "top",
                  fill: "var(--muted-foreground)",
                  fontSize: 10,
                }}
              />
            ))}
            <ReferenceLine
              x={currentHarmonics}
              stroke="var(--primary)"
              strokeWidth={2}
            />
            {/* The cumulative-power curve is the data mark → shared data palette
                (lib/dataviz), matching the morphospace/scree primary hue. The
                vertical "current harmonics" cursor above stays on a theme token. */}
            <Line
              type="monotone"
              dataKey="cum"
              stroke={DATA_PRIMARY}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Use the count for</span>
        {recs.map((r) => (
          <Button
            key={r.threshold}
            size="sm"
            variant={currentHarmonics === r.harmonics ? "default" : "outline"}
            className="h-7 tabular-nums"
            onClick={() => onUseHarmonics(r.harmonics)}
          >
            {PCT(r.threshold)} → {r.harmonics}
          </Button>
        ))}
      </div>
    </div>
  )
}
