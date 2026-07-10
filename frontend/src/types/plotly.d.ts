// Ambient declarations for the untyped Plotly packages (no @types shipped).
//
// We use `plotly.js-basic-dist-min` — the "basic" partial bundle (scatter + bar +
// pie traces only), ~1 MB vs the full dist's ~4.6 MB. The morphospace is a scatter
// (with a numeric colourbar), all of which the basic bundle includes, so it renders
// unchanged (Phase 10 bundle diet). Paired with react-plotly.js's factory + the
// stage's React.lazy, the plot still lands in its own on-demand chunk. Neither
// package ships types; these keep the import type-safe enough without pulling the
// full (heavy) `@types/plotly.js` surface.

declare module "plotly.js-basic-dist-min" {
  const Plotly: unknown
  export default Plotly
}

declare module "react-plotly.js/factory" {
  import type { ComponentType } from "react"

  export interface PlotParams {
    data: unknown[]
    layout?: Record<string, unknown>
    config?: Record<string, unknown>
    style?: React.CSSProperties
    className?: string
    useResizeHandler?: boolean
    onInitialized?: (figure: unknown, graphDiv: HTMLElement) => void
    onUpdate?: (figure: unknown, graphDiv: HTMLElement) => void
    [key: string]: unknown
  }

  const createPlotlyComponent: (plotly: unknown) => ComponentType<PlotParams>
  export default createPlotlyComponent
}
