// Data-visualisation colour palette — the ONE source of truth for chart *data
// marks* across the app (the Plotly morphospace scatter and the Recharts EFA/PCA
// charts alike).
//
// SANCTIONED HEX DEVIATION (Phase 10): CLAUDE.md forbids inline hex and routes all
// colour through the shadcn/Tailwind design tokens. That rule governs *chart chrome*
// — axes, grid, tooltip, text — which still tracks the light/dark theme via tokens.
// Data-mark colours are different: a category's colour must be STABLE (it encodes
// identity, not a theme accent) and must survive colour-vision deficiency. Neither
// is expressible as a theme token, so data marks use this fixed palette instead.
//
// Palette = Okabe & Ito's colourblind-safe qualitative set, in its canonical order.
// Validated with the dataviz skill's checker: adjacent-pair CVD separation ΔE 17.9
// (deuteranopia) — comfortably above the ΔE 12 floor, so groups stay distinct for
// every colour-vision type. The last two slots (yellow, grey) are the weakest on a
// light surface (yellow is low-contrast on near-white); they sit last deliberately,
// so a scatter only reaches them at ≥7 groups, and the plot's legend always provides
// the required non-colour (label) encoding.

/** Okabe–Ito qualitative palette. Assign in fixed order; never cycle a 9th hue. */
export const CATEGORICAL = [
  "#0072B2", // blue
  "#E69F00", // orange
  "#009E73", // green
  "#CC79A7", // reddish purple
  "#D55E00", // vermilion
  "#56B4E9", // sky blue
  "#F0E442", // yellow   (weak contrast on light — kept last)
  "#999999", // grey     (low chroma — kept last)
] as const

/** Primary data-series colour (blue) — the default single-series mark. */
export const DATA_PRIMARY = CATEGORICAL[0]

/** Secondary data-series colour (orange) — the second series on a two-series chart. */
export const DATA_SECONDARY = CATEGORICAL[1]

/** Continuous colourscale for numeric encodings (perceptually-uniform, CVD-friendly). */
export const SEQUENTIAL = "Viridis"
