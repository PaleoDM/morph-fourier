"""Pydantic models mirroring ``frontend/src/types/domain.ts`` (ROADMAP §3).

**Casing (binding):** every model serializes to camelCase — the same keys as the
TypeScript interfaces, both on the wire and on disk. This is achieved with
``alias_generator=to_camel`` + ``populate_by_name=True`` (so Python code can
still construct models with snake_case field names), and callers dump with
``by_alias=True`` (``state.save_state`` does this automatically).

These models are the single source of truth on the Python side; the frontend
regenerates its client types from the FastAPI OpenAPI schema in Phase 1B, so the
two never drift.
"""

from __future__ import annotations

from typing import Literal, Optional, Union

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

# ---------- Enums / constants (ROADMAP §3e) ----------

STATUS = ("unreviewed", "accepted", "rejected")
COLUMN_TYPES = ("categorical", "numeric")
DEFAULT_HARMONICS = 12
MAX_HARMONICS = 30
DEFAULT_OUTLINE_POINTS = 1024
DEFAULT_VARIANCE_TARGET = 0.95
ANCHOR_SIMPLIFY_TARGET = 30

Status = Literal["unreviewed", "accepted", "rejected"]
ColumnType = Literal["categorical", "numeric"]
# Start-point landmark for orientation-preserving EFA normalization: the outline is
# rolled to begin at its most-extreme vertex in this direction (in the oriented frame).
AnchorDir = Literal["top", "bottom", "left", "right"]
BinarySource = Literal["auto", "manual"]
OrientSource = Literal["manual", "learned"]
AutoSource = Literal["auto", "manual", "primed"]
AutoFlagReason = Literal["low_confidence", "detection_failed"]

# Mirror of ``autodetect.MATCH_HARMONICS`` (kept here so models.py stays free of the
# heavy autodetect→analysis→pyefd import chain; the automate router passes the live
# value from autodetect when it builds an ExemplarSet).
DEFAULT_MATCH_HARMONICS = 8


def priming_count(n_canonicals: int) -> int:
    """PRIMING_COUNT(nCanonicals) = max(5, min(15, round(0.10 * nCanonicals)))."""
    return max(5, min(15, round(0.10 * n_canonicals)))


# ---------- Base ----------


class MFModel(BaseModel):
    """Base model: camelCase aliases on the wire/disk, snake_case in Python."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
    )


# ---------- 3a. Series & specimens ----------


class Series(MFModel):
    key: str  # sanitized: lowercase, non-alnum → "_"
    display_name: str  # raw folder name
    photo_count: int  # number of parseable image files


class PhotoRecord(MFModel):
    record_key: str  # stable id: `${seriesKey}/${filename}`
    series_key: str
    filename: str
    specimen_id: str  # human-readable, e.g. "USNM 49775" or just "49775"
    specimen_id_safe: str  # filename-safe, e.g. "USNM_49775"
    specimen_key: str  # `${specimenIdSafe}__${seriesKey}`
    label: str  # free display label parsed from filename
    photo_index: int  # nth photo of this specimen


class SeriesRecords(MFModel):
    """Envelope for ``GET /api/{series}/records`` — every parsed photo in a series
    plus the filenames that did not parse (surfaced, never silently dropped)."""

    records: list[PhotoRecord] = []
    unparseable: list[str] = []  # filenames that failed the parser


# ---------- 3b. Stage state files ----------


class PhotoDecision(MFModel):
    status: Status
    rejection_reason: Optional[str] = None
    is_canonical: bool = False
    notes: str = ""


class CurationState(MFModel):
    schema_version: Literal[1] = 1
    updated_at: str  # ISO 8601
    photos: dict[str, PhotoDecision] = {}  # key = recordKey


class Orientation(MFModel):
    angle_deg: float  # rotation to apply, degrees CCW
    source: OrientSource  # "manual" | "learned"
    is_priming_example: bool = False


class LearnedReference(MFModel):
    priming_record_keys: list[str]
    reference_coeffs: list[float]  # flattened mean EFA coeffs of oriented priming set
    harmonics_used: int  # harmonics used to build the signature (default 8)
    built_at: str


class OrientState(MFModel):
    schema_version: Literal[1] = 1
    updated_at: str
    locked_at: Optional[str] = None
    orientations: dict[str, Orientation] = {}  # key = recordKey (canonicals only)
    learned_reference: Optional[LearnedReference] = None


class CropBox(MFModel):
    x1: float  # top-left, in ROTATED-image pixel coords
    y1: float
    x2: float  # bottom-right
    y2: float
    source: BinarySource


class CropState(MFModel):
    schema_version: Literal[1] = 1
    updated_at: str
    locked_at: Optional[str] = None
    crops: dict[str, CropBox] = {}  # key = recordKey


class Point(MFModel):
    x: float
    y: float


class SeedPoint(MFModel):
    x: float
    y: float
    label: Literal[0, 1]  # 1 = positive, 0 = negative


class MaskEntry(MFModel):
    seed_points: list[SeedPoint] = []  # SAM prompts (retained for reproducibility)
    anchor_path: Optional[list[Point]] = None  # user-edited pen-tool anchors
    source: BinarySource
    outline_point_count: int  # resampled outline length written to CSV
    outline_rel_path: str  # e.g. "state/dorsal/outlines/USNM_49775.csv"


class MaskState(MFModel):
    schema_version: Literal[1] = 1
    updated_at: str
    locked_at: Optional[str] = None
    masks: dict[str, MaskEntry] = {}  # key = recordKey


class EfaSettings(MFModel):
    schema_version: Literal[1] = 1
    last_computed_at: Optional[str] = None
    harmonics: int = DEFAULT_HARMONICS
    normalize: bool = True  # orientation-preserving normalization (size + start point)
    anchor: AnchorDir = "top"  # start-point landmark when normalize is on
    n_specimens_computed: int = 0


class PcaSettings(MFModel):
    schema_version: Literal[1] = 1
    last_computed_at: Optional[str] = None
    n_components_retained: Optional[int] = None  # null → auto from varianceTarget
    variance_target: float = DEFAULT_VARIANCE_TARGET
    n_components_total: int = 0
    harmonics_used: Optional[int] = None  # detect drift vs current EFA setting
    excluded_specimens: list[str] = []  # specimenIdSafe values dropped from the PCA fit


class TaxonomyColumn(MFModel):
    name: str
    type: ColumnType


class TaxonomyState(MFModel):
    schema_version: Literal[1] = 1
    updated_at: str
    columns: list[TaxonomyColumn] = []
    # key = specimenIdSafe → { columnName → value }
    assignments: dict[str, dict[str, Union[str, float, None]]] = {}


# ---------- 3c. Prime → Automate → Review (Phase 11 redesign) ----------
#
# Mirrors of ``PIPELINE_REDESIGN.md`` §3, with two deliberate corrections carried
# forward from 11A (see apps/morph-fourier/CLAUDE.md "11B carry-forwards"):
#  - ``Exemplar`` persists the oriented ``outline`` (dense), not just ``efaCoeffs``.
#    Angle recovery reads the outline's first-harmonic phase, which the rotation-
#    normalized coefficients discard. (Corrects spec §3.)
#  - ``efaCoeffs`` is nested ``[harmonic][a,b,c,d]`` rather than a flat list, so it
#    round-trips the ``(harmonics, 4)`` block losslessly.


class Exemplar(MFModel):
    """A fully-processed primed training specimen (the "training data")."""

    record_key: str  # the primed canonical
    crop_box: CropBox  # RAW-photo frame (crop-before-orient; spec §6)
    angle_deg: float  # display orientation the user set (PIL/Konva CCW)
    anchor_path: list[Point]  # simplified oriented mask outline control points
    outline: list[Point]  # dense oriented outline — angle recovery + match key source
    efa_coeffs: list[list[float]]  # normalized EFA, [harmonic][a,b,c,d] — the match key


class ExemplarSet(MFModel):
    """The exemplar set = the learned model for one series (``exemplars.json``)."""

    schema_version: Literal[1] = 1
    harmonics: int = DEFAULT_MATCH_HARMONICS  # MATCH_HARMONICS used for efaCoeffs
    exemplars: list[Exemplar] = []


class AutoResult(MFModel):
    """Provenance for one auto-processed specimen, before Review (spec §3).

    ``flagReason`` is one of the two top-level buckets; ``flagDetail`` keeps the
    specific 11A internal reason (``no_bone_colour`` | ``warm_background`` |
    ``low_sam_score`` | ``scale_card`` | ``segmentation_failed``) for the UI.
    """

    record_key: str
    source: AutoSource
    matched_exemplar_key: Optional[str] = None  # nearest exemplar (null if none)
    match_distance: Optional[float] = None  # EFA distance to that exemplar
    flagged: bool = False
    flag_reason: Optional[AutoFlagReason] = None
    flag_detail: Optional[str] = None  # the specific 11A reason, kept for Review


class AutoResultsState(MFModel):
    """Per-series auto-processing provenance (``auto_results.json``)."""

    schema_version: Literal[1] = 1
    updated_at: str
    results: dict[str, AutoResult] = {}  # key = recordKey


# ---------- 3d. API response envelopes ----------


class StageStatus(MFModel):
    series_key: str
    locked: bool = False  # stages 2–4 only
    last_computed_at: Optional[str] = None  # stages 6–8 only
    ready_count: int = 0  # how many canonicals have this stage done
    total_canonicals: int = 0


class SegmentResult(MFModel):
    anchor_path: list[Point]  # simplified control points (~20–40)
    outline_point_count: int


class RecommendedHarmonic(MFModel):
    threshold: float
    harmonics: int


class CalibrationResult(MFModel):
    mean_curve: list[float]  # cumulative power per harmonic (len = maxHarmonics)
    recommended: list[RecommendedHarmonic]
    n_specimens: int


class PcaResult(MFModel):
    specimen_ids: list[str]
    scores: list[list[float]]  # [specimen][component]
    var_ratio: list[float]
    cum_var_ratio: list[float]
    loadings: list[list[float]]  # [component][feature]
    mean: list[float]  # per-feature mean (needed for back-projection)
    feature_names: list[str]
    n_components: int


class ReconstructResult(MFModel):
    outline: list[Point]  # reconstructed closed outline
    power_spectrum: Optional[list[float]] = None  # per-harmonic power (Stage 6 only)


class ExportSkip(MFModel):
    record_key: str
    reason: str


class ExportResult(MFModel):
    manifest_path: str  # relative path to the written manifest.csv
    exported_count: int
    skipped: list[ExportSkip] = []


class AutomateSummary(MFModel):
    """Return of ``POST /api/{series}/automate`` — one batch's outcome counts."""

    series_key: str
    processed: int  # non-primed canonicals attempted
    primed: int = 0  # primed exemplars carried forward into geometry state
    known_good_preserved: int = 0  # user-refined ("known good") specimens skipped + reused
    auto_isolated: int  # got a crop + mask written (detection + segmentation succeeded)
    matched: int  # confident matches (auto-isolated and NOT flagged)
    flagged: int  # total flagged (surfaced first in Review)
    flagged_low_confidence: int
    flagged_detection_failed: int
    elapsed_seconds: float
    skipped_no_exemplars: bool = False  # true → the exemplar set was empty (prime first)


# ---------- Request bodies (Phase 1B) ----------
#
# Inputs the frontend POSTs/PUTs. Not part of the hand-mirrored §3 domain
# contract — they belong to the API surface and reach the client automatically
# through the OpenAPI → api.gen.ts codegen (which is the single source of truth
# for request shapes). Kept here so every API model lives in one place.


class SegmentRequest(MFModel):
    record_key: str
    seed_points: list[SeedPoint] = []  # optional SAM prompts; empty → center seed


class MaskUpdateRequest(MFModel):
    """PUT /mask/{recordKey}: persist the (possibly edited) anchor path."""

    record_key: str
    anchor_path: list[Point]  # the outline authority (pen-tool control points)
    seed_points: list[SeedPoint] = []
    source: BinarySource = "manual"


class PrimeSegmentRequest(MFModel):
    """POST /prime/segment: SAM box-predict inside a RAW-frame box (crop-before-orient).

    ``box`` is the crop the user drew on the raw photo — it is both the crop and the
    SAM prompt (spec §4). Returns a :class:`SegmentResult` whose anchor coords live in
    the cropped (box) frame, matching the cropped image the editor draws on.
    """

    record_key: str
    box: CropBox


class PrimeExemplarRequest(MFModel):
    """PUT /prime/exemplar: persist one primed exemplar (Prime writes this per specimen).

    The client sends only the raw materials — ``cropBox`` (raw frame), the display
    ``angleDeg`` the puck set, and the refined ``anchorPath`` in the *box* frame. The
    backend derives everything else (dense oriented outline + normalized ``efaCoeffs``),
    so the EFA math stays server-side (spec §3 / 11C). Upserts into ``exemplars.json``.
    """

    record_key: str
    crop_box: CropBox  # RAW-photo frame (crop-before-orient; spec §6)
    angle_deg: float  # display orientation the user set (PIL/Konva CCW)
    anchor_path: list[Point]  # refined mask control points, in the box (cropped) frame


class EfaComputeRequest(MFModel):
    # All optional — omit to reuse the persisted efa_settings values.
    harmonics: Optional[int] = None
    normalize: Optional[bool] = None
    anchor: Optional[AnchorDir] = None


class EfaReconstructRequest(MFModel):
    record_key: str
    harmonics: Optional[int] = None
    normalize: bool = True
    anchor: AnchorDir = "top"


class PcaRunRequest(MFModel):
    n_components_retained: Optional[int] = None
    variance_target: Optional[float] = None
    excluded_specimens: Optional[list[str]] = None  # null → leave the current exclusion set unchanged


class PcaReconstructRequest(MFModel):
    # {"1": 1.5, "2": -0.3} — PC index (data key, kept as-is) → score along that PC.
    pc_values: dict[str, float] = {}


__all__ = [
    "STATUS",
    "COLUMN_TYPES",
    "DEFAULT_HARMONICS",
    "MAX_HARMONICS",
    "DEFAULT_OUTLINE_POINTS",
    "DEFAULT_VARIANCE_TARGET",
    "ANCHOR_SIMPLIFY_TARGET",
    "priming_count",
    "MFModel",
    "Series",
    "PhotoRecord",
    "SeriesRecords",
    "PhotoDecision",
    "CurationState",
    "Orientation",
    "LearnedReference",
    "OrientState",
    "CropBox",
    "CropState",
    "Point",
    "SeedPoint",
    "MaskEntry",
    "MaskState",
    "EfaSettings",
    "PcaSettings",
    "TaxonomyColumn",
    "TaxonomyState",
    "DEFAULT_MATCH_HARMONICS",
    "Exemplar",
    "ExemplarSet",
    "AutoResult",
    "AutoResultsState",
    "AutomateSummary",
    "StageStatus",
    "SegmentResult",
    "RecommendedHarmonic",
    "CalibrationResult",
    "PcaResult",
    "ReconstructResult",
    "ExportSkip",
    "ExportResult",
    "SegmentRequest",
    "MaskUpdateRequest",
    "PrimeSegmentRequest",
    "PrimeExemplarRequest",
    "EfaComputeRequest",
    "EfaReconstructRequest",
    "PcaRunRequest",
    "PcaReconstructRequest",
]
