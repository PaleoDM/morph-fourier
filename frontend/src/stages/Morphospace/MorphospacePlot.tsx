import { useMemo } from "react"
import Plotly from "plotly.js-basic-dist-min"
import createPlotlyComponent from "react-plotly.js/factory"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useThemeStore } from "@/state/useThemeStore"
import { CATEGORICAL, SEQUENTIAL } from "@/lib/dataviz"
import type { TaxonomyColumn } from "@/types/domain"
import type { PlotSpecimen } from "./types"

// react-plotly.js bound to the "basic" partial bundle (scatter + bar + pie — all the
// morphospace needs). Because this whole module is React.lazy'd by the stage, this
// import lands in its own on-demand chunk (bundle diet).
const Plot = createPlotlyComponent(Plotly)

// Discrete groups use the shared Okabe–Ito colourblind-safe palette (lib/dataviz).
// Plotly can't consume our CSS design tokens (it does its own colour math, unlike
// the Recharts SVG stages), so data marks take the fixed palette directly; the chart
// *chrome* (text/grid) still tracks the light/dark theme below.
const PALETTE = CATEGORICAL

/** Theme-tracking chrome colours (resolved, not CSS vars — Plotly needs concretes). */
function chromeFor(theme: "light" | "dark") {
  return theme === "dark"
    ? { text: "#a3a3a3", grid: "rgba(255,255,255,0.12)", markerLine: "#1c1c1c" }
    : { text: "#525252", grid: "#e5e5e5", markerLine: "#ffffff" }
}

interface MorphospacePlotProps {
  data: PlotSpecimen[]
  columns: TaxonomyColumn[]
  retained: number
  xPc: number
  yPc: number
  colorBy: string
  onXPc: (pc: number) => void
  onYPc: (pc: number) => void
  onColorBy: (col: string) => void
}

/**
 * Stage 8 — the interactive morphospace scatter (ROADMAP Phase 9 step 2). Each
 * specimen sits at its (PC-x, PC-y) score. Colour by any taxonomy column: a
 * categorical column becomes a discrete legend (Plotly's native legend-click hides
 * or shows a group — that's the filtering), a numeric column a continuous colourbar.
 * Hover shows the specimen id + all its metadata. PNG export is Plotly's native
 * camera button. Default-exported so the stage can React.lazy it into its own chunk.
 */
export default function MorphospacePlot({
  data,
  columns,
  retained,
  xPc,
  yPc,
  colorBy,
  onXPc,
  onYPc,
  onColorBy,
}: MorphospacePlotProps) {
  const theme = useThemeStore((s) => s.theme)
  const chrome = chromeFor(theme)

  const pcOptions = useMemo(
    () => Array.from({ length: Math.max(retained, 1) }, (_, i) => i + 1),
    [retained],
  )

  const activeColumn = columns.find((c) => c.name === colorBy) ?? null

  const hoverText = useMemo(() => {
    return (d: PlotSpecimen) => {
      const lines = [`<b>${d.specimenId}</b>`]
      for (const c of columns) {
        const v = d.metadata[c.name]
        lines.push(`${c.name}: ${v == null || v === "" ? "—" : v}`)
      }
      return lines.join("<br>")
    }
  }, [columns])

  const traces = useMemo(() => {
    const xs = (d: PlotSpecimen) => d.scores[xPc - 1]
    const ys = (d: PlotSpecimen) => d.scores[yPc - 1]
    const baseMarker = {
      size: 11,
      opacity: 0.85,
      line: { width: 1, color: chrome.markerLine },
    }

    // No colour / unknown column → one plain trace.
    if (!activeColumn) {
      return [
        {
          type: "scatter",
          mode: "markers",
          x: data.map(xs),
          y: data.map(ys),
          text: data.map(hoverText),
          hovertemplate: "%{text}<extra></extra>",
          marker: { ...baseMarker, color: PALETTE[0] },
          showlegend: false,
        },
      ]
    }

    // Numeric → single trace, continuous colourbar.
    if (activeColumn.type === "numeric") {
      const values = data.map((d) => {
        const v = d.metadata[activeColumn.name]
        return typeof v === "number" ? v : v == null || v === "" ? null : Number(v)
      })
      return [
        {
          type: "scatter",
          mode: "markers",
          x: data.map(xs),
          y: data.map(ys),
          text: data.map(hoverText),
          hovertemplate: "%{text}<extra></extra>",
          marker: {
            ...baseMarker,
            color: values,
            colorscale: SEQUENTIAL,
            showscale: true,
            colorbar: {
              title: { text: activeColumn.name, side: "right" },
              thickness: 12,
              outlinewidth: 0,
              tickfont: { color: chrome.text, size: 10 },
              titlefont: { color: chrome.text, size: 11 },
            },
          },
          showlegend: false,
        },
      ]
    }

    // Categorical → one trace per distinct value (discrete legend + click-to-filter).
    const groups = new Map<string, PlotSpecimen[]>()
    for (const d of data) {
      const raw = d.metadata[activeColumn.name]
      const key = raw == null || raw === "" ? "—" : String(raw)
      const arr = groups.get(key)
      if (arr) arr.push(d)
      else groups.set(key, [d])
    }
    return Array.from(groups.entries()).map(([label, items], i) => ({
      type: "scatter",
      mode: "markers",
      name: label,
      x: items.map(xs),
      y: items.map(ys),
      text: items.map(hoverText),
      hovertemplate: "%{text}<extra></extra>",
      marker: { ...baseMarker, color: PALETTE[i % PALETTE.length] },
    }))
  }, [data, activeColumn, xPc, yPc, hoverText, chrome])

  const layout = useMemo(
    () => ({
      autosize: true,
      height: 460,
      margin: { l: 52, r: 16, t: 12, b: 44 },
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      font: { color: chrome.text, size: 12 },
      hovermode: "closest",
      hoverlabel: { align: "left" },
      dragmode: "pan",
      xaxis: {
        title: { text: `PC${xPc}`, font: { size: 12, color: chrome.text } },
        zeroline: true,
        zerolinecolor: chrome.grid,
        gridcolor: chrome.grid,
        linecolor: chrome.grid,
        tickfont: { size: 10 },
      },
      yaxis: {
        title: { text: `PC${yPc}`, font: { size: 12, color: chrome.text } },
        zeroline: true,
        zerolinecolor: chrome.grid,
        gridcolor: chrome.grid,
        linecolor: chrome.grid,
        tickfont: { size: 10 },
        scaleanchor: "x",
        scaleratio: 1,
      },
      legend: {
        font: { size: 11, color: chrome.text },
        itemsizing: "constant",
        bgcolor: "rgba(0,0,0,0)",
      },
    }),
    [xPc, yPc, chrome],
  )

  const config = useMemo(
    () => ({
      displaylogo: false,
      responsive: true,
      scrollZoom: true,
      modeBarButtonsToRemove: ["lasso2d", "select2d", "autoScale2d"],
      toImageButtonOptions: {
        format: "png",
        filename: `morphospace_PC${xPc}_PC${yPc}`,
        scale: 2,
      },
    }),
    [xPc, yPc],
  )

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      {/* Controls */}
      <div className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-2">
        <PcSelect label="X axis" value={xPc} options={pcOptions} onChange={onXPc} />
        <PcSelect label="Y axis" value={yPc} options={pcOptions} onChange={onYPc} />
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-muted-foreground">Colour by</label>
          <Select value={colorBy} onValueChange={onColorBy}>
            <SelectTrigger className="h-8 w-40" aria-label="Colour by">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
              {columns.map((c) => (
                <SelectItem key={c.name} value={c.name}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {data.length === 0 ? (
        <div className="flex h-[460px] items-center justify-center text-sm text-muted-foreground">
          No specimens with PCA scores to plot.
        </div>
      ) : (
        <Plot
          data={traces}
          layout={layout}
          config={config}
          useResizeHandler
          style={{ width: "100%", height: "460px" }}
        />
      )}
      {activeColumn?.type === "categorical" && (
        <p className="mt-1 text-center text-[11px] text-muted-foreground">
          Click a legend entry to hide or show that group.
        </p>
      )}
    </div>
  )
}

function PcSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: number
  options: number[]
  onChange: (pc: number) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
        <SelectTrigger className="h-8 w-24" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((pc) => (
            <SelectItem key={pc} value={String(pc)}>
              PC{pc}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
