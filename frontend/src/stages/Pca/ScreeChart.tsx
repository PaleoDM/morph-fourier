import { useMemo } from "react"
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"

import { DATA_PRIMARY, DATA_SECONDARY } from "@/lib/dataviz"

const TOOLTIP_STYLE = {
  background: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--popover-foreground)",
  fontSize: 12,
  padding: "6px 10px",
} as const

const PCT = (v: number) => `${(v * 100).toFixed(0)}%`

interface ScreeChartProps {
  varRatio: number[]
  cumVarRatio: number[]
  /** Retained-component count — drawn as a vertical divider. */
  retained: number
  /** Variance target — drawn as a horizontal line on the cumulative axis. */
  varianceTarget: number
}

/**
 * Twin-axis scree plot. Bars (left axis) are each PC's share of variance; the line
 * (right axis, 0–100%) is the running cumulative total. A vertical marker sits at
 * the retained-component count and a horizontal marker at the variance target, so
 * "how many PCs reach 95%?" is answerable at a glance.
 *
 * Twin axis in Recharts: a single <ComposedChart> with two <YAxis> elements
 * distinguished by `yAxisId` ("left" default-oriented, "right" orientation="right").
 * Each series names the axis it belongs to (Bar → left, Line → right). Without the
 * matching yAxisId the series silently fails to render — that's the one gotcha.
 */
export function ScreeChart({
  varRatio,
  cumVarRatio,
  retained,
  varianceTarget,
}: ScreeChartProps) {
  const data = useMemo(
    () =>
      varRatio.map((v, i) => ({
        pc: `PC${i + 1}`,
        variance: v,
        cumulative: cumVarRatio[i],
      })),
    [varRatio, cumVarRatio],
  )

  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 12, right: 8, bottom: 4, left: -8 }}>
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="pc"
            tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
            tickLine={{ stroke: "var(--border)" }}
            axisLine={{ stroke: "var(--border)" }}
            interval={data.length > 16 ? Math.floor(data.length / 12) : 0}
          />
          <YAxis
            yAxisId="left"
            tickFormatter={PCT}
            tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
            tickLine={{ stroke: "var(--border)" }}
            axisLine={{ stroke: "var(--border)" }}
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            domain={[0, 1]}
            tickFormatter={PCT}
            tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
            tickLine={{ stroke: "var(--border)" }}
            axisLine={{ stroke: "var(--border)" }}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            cursor={{ fill: "var(--muted)", opacity: 0.4 }}
            formatter={(v, name) => [
              PCT(Number(v)),
              name === "variance" ? "per-PC variance" : "cumulative",
            ]}
          />
          <ReferenceLine
            yAxisId="right"
            y={varianceTarget}
            stroke="var(--muted-foreground)"
            strokeDasharray="4 3"
            label={{
              value: PCT(varianceTarget),
              position: "insideTopRight",
              fill: "var(--muted-foreground)",
              fontSize: 10,
            }}
          />
          <ReferenceLine
            yAxisId="left"
            x={`PC${retained}`}
            stroke="var(--primary)"
            strokeWidth={2}
            strokeDasharray="2 2"
          />
          {/* Data marks use the shared colourblind-safe data palette (lib/dataviz),
              not theme tokens: per-PC variance is the primary series, the cumulative
              line the secondary — stable, CVD-distinct, and consistent with the
              Plotly morphospace's first two hues. Chrome/annotations stay on tokens. */}
          <Bar
            yAxisId="left"
            dataKey="variance"
            fill={DATA_PRIMARY}
            fillOpacity={0.85}
            isAnimationActive={false}
          />
          <Line
            yAxisId="right"
            type="monotone"
            dataKey="cumulative"
            stroke={DATA_SECONDARY}
            strokeWidth={2}
            dot={{ r: 2, fill: DATA_SECONDARY }}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
