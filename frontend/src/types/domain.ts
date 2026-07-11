/**
 * Morph-Fourier domain contract (ROADMAP §3).
 *
 * This file is the SINGLE SOURCE OF TRUTH for every entity that crosses the
 * client/server boundary. `backend/src/app/models.py` mirrors it as Pydantic
 * models; Phase 1B wires OpenAPI type generation so the two can never drift.
 *
 * Conventions:
 *  - camelCase everywhere — on the wire AND on disk in the state JSON files.
 *  - No TS enums (tsconfig `erasableSyntaxOnly`): string unions + `as const`.
 *  - All timestamps are ISO 8601 strings.
 */

/* ─── 3a. Series & specimens ─────────────────────────────────────────────── */

/** A series = one immediate subfolder of the photos root, analysed independently. */
export interface Series {
  key: string          // sanitized: lowercase, non-alnum → "_"  (e.g. "dorsal")
  displayName: string  // raw folder name (e.g. "Series 1 (Top view)")
  photoCount: number   // number of parseable image files in the folder
}

/** POST /api/series and POST /api/{series}/upload — outcome of an upload. */
export interface UploadResult {
  series: Series
  uploaded: number       // image files written to disk
  skipped: string[]      // filenames rejected (not a .jpg/.jpeg/.png)
  unrecognized: number   // written, but the filename doesn't match the naming pattern
}

/** One source photo, parsed from its filename. */
export interface PhotoRecord {
  recordKey: string        // stable id: `${seriesKey}/${filename}`
  seriesKey: string
  filename: string
  specimenId: string       // human-readable, e.g. "ABC 49775" or just "49775"
  specimenIdSafe: string   // filename-safe, e.g. "ABC_49775"
  specimenKey: string      // `${specimenIdSafe}__${seriesKey}` — groups multi-photo specimens
  label: string            // free display label parsed from filename (genus/species/etc.)
  photoIndex: number       // nth photo of this specimen
}

/** GET /api/{series}/records — every parsed photo + the filenames that didn't parse. */
export interface SeriesRecords {
  records: PhotoRecord[]
  unparseable: string[]    // filenames that failed the parser (surfaced, never dropped)
}

/* ─── 3b. Stage state files ──────────────────────────────────────────────── */

// curation.json
export type CurationStatus = "unreviewed" | "accepted" | "rejected"

export interface PhotoDecision {
  status: CurationStatus
  rejectionReason: string | null   // free text or from a suggested list
  isCanonical: boolean
  notes: string
}

export interface CurationState {
  schemaVersion: 1
  updatedAt: string                        // ISO 8601
  photos: Record<string, PhotoDecision>    // key = recordKey
}

// orient.json
export type OrientationSource = "manual" | "learned"

export interface Orientation {
  angleDeg: number                 // rotation to apply, degrees CCW
  source: OrientationSource        // was this human-set or auto?
  isPrimingExample: boolean        // did the user hand-orient this to teach the model?
}

export interface LearnedReference {
  primingRecordKeys: string[]      // which canonicals primed the reference
  referenceCoeffs: number[]        // flattened mean EFA coeffs of oriented priming set
  harmonicsUsed: number            // harmonics used to build the signature (default 8)
  builtAt: string
}

export interface OrientState {
  schemaVersion: 1
  updatedAt: string
  lockedAt: string | null
  orientations: Record<string, Orientation>   // key = recordKey (canonicals only)
  learnedReference: LearnedReference | null    // the primed "up" model
}

// crop.json
export type BoxSource = "auto" | "manual"

export interface CropBox {
  x1: number
  y1: number                       // top-left, in ROTATED-image pixel coords
  x2: number
  y2: number                       // bottom-right
  source: BoxSource
}

export interface CropState {
  schemaVersion: 1
  updatedAt: string
  lockedAt: string | null
  crops: Record<string, CropBox>   // key = recordKey
}

// mask.json
export interface Point {
  x: number
  y: number
}

export interface SeedPoint {
  x: number
  y: number
  label: 0 | 1                     // 1 = positive, 0 = negative
}

export interface MaskEntry {
  seedPoints: SeedPoint[]          // SAM prompts (retained for reproducibility)
  anchorPath: Point[] | null       // user-edited pen-tool anchors (the outline authority)
  source: BoxSource
  outlinePointCount: number        // resampled outline length written to CSV (e.g. 1024)
  outlineRelPath: string           // e.g. "state/dorsal/outlines/ABC_49775.csv"
}

export interface MaskState {
  schemaVersion: 1
  updatedAt: string
  lockedAt: string | null
  masks: Record<string, MaskEntry> // key = recordKey
}

// Start-point landmark for orientation-preserving normalization.
export type AnchorDir = "top" | "bottom" | "left" | "right"

// efa_settings.json
export interface EfaSettings {
  schemaVersion: 1
  lastComputedAt: string | null
  harmonics: number                // default 12
  normalize: boolean               // orientation-preserving normalize (size + start point)
  anchor: AnchorDir                // start-point landmark when normalize is on; default "top"
  nSpecimensComputed: number
}

// pca_settings.json
export interface PcaSettings {
  schemaVersion: 1
  lastComputedAt: string | null
  nComponentsRetained: number | null   // null → auto from varianceTarget
  varianceTarget: number                // default 0.95
  nComponentsTotal: number
  harmonicsUsed: number | null          // detect drift vs current EFA setting
  excludedSpecimens: string[]           // specimenIdSafe values dropped from the PCA fit
}

// taxonomy.json
export type ColumnType = "categorical" | "numeric"

export interface TaxonomyColumn {
  name: string
  type: ColumnType
}

export interface TaxonomyState {
  schemaVersion: 1
  updatedAt: string
  columns: TaxonomyColumn[]
  // key = specimenIdSafe → { columnName → value }
  assignments: Record<string, Record<string, string | number | null>>
}

/* ─── 3c. Prime → Automate → Review (Phase 11 redesign) ──────────────────── */

// Mirrors backend/src/app/models.py. Two corrections carried forward from 11A
// (see apps/morph-fourier/CLAUDE.md "11B carry-forwards"):
//  - Exemplar persists the oriented `outline` (dense), not just `efaCoeffs` —
//    angle recovery reads the outline's first-harmonic phase, which the
//    rotation-normalized coefficients discard. (Corrects spec §3.)
//  - `efaCoeffs` is nested `[harmonic][a,b,c,d]`, round-tripping the
//    (harmonics × 4) block losslessly.

/** A primed exemplar — a fully-processed training specimen. exemplars.json */
export interface Exemplar {
  recordKey: string        // the primed canonical
  cropBox: CropBox         // RAW-photo frame (crop-before-orient; spec §6)
  angleDeg: number         // display orientation the user set (PIL/Konva CCW)
  anchorPath: Point[]      // simplified oriented mask outline control points
  outline: Point[]         // dense oriented outline — angle recovery + match key source
  efaCoeffs: number[][]    // normalized EFA, [harmonic][a,b,c,d] — the match key
}

/** The exemplar set = the learned model for one series. state/{seriesKey}/exemplars.json */
export interface ExemplarSet {
  schemaVersion: 1
  harmonics: number        // MATCH_HARMONICS used for efaCoeffs (default 8)
  exemplars: Exemplar[]
}

export type AutoSource = "auto" | "manual" | "primed"
export type AutoFlagReason = "low_confidence" | "detection_failed"

/** Provenance for one auto-processed specimen, before Review. */
export interface AutoResult {
  recordKey: string
  source: AutoSource
  matchedExemplarKey: string | null   // nearest exemplar (null if none)
  matchDistance: number | null        // EFA distance to that exemplar
  flagged: boolean                     // below threshold OR detection failed
  flagReason: AutoFlagReason | null
  // The specific 11A internal reason kept for Review:
  // "no_bone_colour" | "warm_background" | "low_sam_score" | "scale_card" | "segmentation_failed"
  flagDetail: string | null
}

/** Per-series auto-processing provenance. state/{seriesKey}/auto_results.json */
export interface AutoResultsState {
  schemaVersion: 1
  updatedAt: string
  results: Record<string, AutoResult>  // key = recordKey
}

/* ─── 3d. API response envelopes ─────────────────────────────────────────── */

/** Returned by every stage's GET. */
export interface StageStatus {
  seriesKey: string
  locked: boolean                  // stages 2–4 only
  lastComputedAt: string | null    // stages 6–8 only
  readyCount: number               // how many canonicals have this stage done
  totalCanonicals: number
}

/** POST /api/{series}/mask/segment */
export interface SegmentResult {
  anchorPath: Point[]              // simplified control points (~20–40)
  outlinePointCount: number
}

/** POST /api/{series}/efa/calibrate */
export interface CalibrationResult {
  meanCurve: number[]              // cumulative power per harmonic (len = maxHarmonics)
  recommended: { threshold: number; harmonics: number }[]
  nSpecimens: number
}

/** GET /api/{series}/pca */
export interface PcaResult {
  specimenIds: string[]
  scores: number[][]               // [specimen][component]
  varRatio: number[]
  cumVarRatio: number[]
  loadings: number[][]             // [component][feature]
  mean: number[]                   // per-feature mean (needed for back-projection)
  featureNames: string[]
  nComponents: number
}

/**
 * POST /api/{series}/efa/reconstruct  (Stage 6 inspector)
 * POST /api/{series}/pca/reconstruct  (Stage 9 shape-along-PC)
 */
export interface ReconstructResult {
  outline: Point[]                 // reconstructed closed outline
  powerSpectrum: number[] | null   // per-harmonic power (Stage 6 inspector only; null otherwise)
}

/** POST /api/{series}/export */
export interface ExportResult {
  manifestPath: string             // relative path to the written manifest.csv
  exportedCount: number
  skipped: { recordKey: string; reason: string }[]
}

/** POST /api/{series}/automate — one batch's outcome counts. */
export interface AutomateSummary {
  seriesKey: string
  processed: number                // non-primed canonicals attempted
  primed: number                   // primed exemplars carried forward into geometry state
  knownGoodPreserved: number       // user-refined ("known good") specimens skipped + reused
  autoIsolated: number             // got a crop + mask written
  matched: number                  // confident matches (auto-isolated and NOT flagged)
  flagged: number                  // total flagged (surfaced first in Review)
  flaggedLowConfidence: number
  flaggedDetectionFailed: number
  elapsedSeconds: number
  skippedNoExemplars: boolean      // true → exemplar set was empty (prime first)
}

/* ─── 3e. Enums / constants ──────────────────────────────────────────────── */

export const STATUS = ["unreviewed", "accepted", "rejected"] as const
export const COLUMN_TYPES = ["categorical", "numeric"] as const

export const DEFAULT_HARMONICS = 12
export const MAX_HARMONICS = 30
export const DEFAULT_OUTLINE_POINTS = 1024
export const DEFAULT_VARIANCE_TARGET = 0.95
export const ANCHOR_SIMPLIFY_TARGET = 30  // control points after Douglas-Peucker on SAM outline

/** Priming count for learned orientation (ROADMAP §6 / Phase 4). */
export function primingCount(nCanonicals: number): number {
  return Math.max(5, Math.min(15, Math.round(0.1 * nCanonicals)))
}

/* ─── Stage catalogue (UI concern — the 8-stage pipeline) ────────────────── */

// Stable identifiers for the pipeline stages, in rail order.
//
// The Phase-11 redesign replaces the manual Orient → Crop → Mask stages with the
// prime-then-auto-detect flow: **Prime** (build the exemplar set) → **Automate**
// (batch auto-detect the rest) → **Review** (inspect + refine + lock). The old
// Orient/Crop/Mask tabs were retired in 11D; their Konva editor components live on,
// reused inside the Prime/Review box-frame wizard. Stages 5–8 are unchanged.
export const STAGE_IDS = [
  "curation",
  "prime",
  "automate",
  "review",
  "gallery",
  "efa",
  "pca",
  "morphospace",
] as const

export type StageId = (typeof STAGE_IDS)[number]

/** Which stages gate downstream work — the exemplar set, the Review lock, or free exploration. */
export interface StageMeta {
  id: StageId
  index: number          // 1-based position in the pipeline
  label: string          // rail display name
  gate: "lock" | "prime" | "automate" | "review" | "export" | "compute"
}

export const STAGES: StageMeta[] = [
  { id: "curation", index: 1, label: "Curation", gate: "lock" },
  { id: "prime", index: 2, label: "Prime", gate: "prime" },
  { id: "automate", index: 3, label: "Automate", gate: "automate" },
  { id: "review", index: 4, label: "Review", gate: "review" },
  { id: "gallery", index: 5, label: "Gallery", gate: "export" },
  { id: "efa", index: 6, label: "EFA", gate: "compute" },
  { id: "pca", index: 7, label: "PCA", gate: "compute" },
  { id: "morphospace", index: 8, label: "Morphospace", gate: "compute" },
]
