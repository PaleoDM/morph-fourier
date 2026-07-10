"""Auto-detect + exemplar-match core for the Prime → Automate → Review redesign.

This is the pure-Python backend logic behind Stage 3 (Automate): for a raw photo
of a cluttered specimen tray (target basihyal complex + stylohyals + scale card),

    detect_target_box  → segment_in_box → match_nearest_exemplar → recover_angle

isolates the *one* target bone, matches it to a primed exemplar, and recovers its
display orientation. No HTTP, no UI, no state I/O — Phase 11B wires this into an
endpoint + ``exemplars.json``. See ``docs/PIPELINE_REDESIGN.md`` §3–§4a.

Two domain facts drive the algorithm (spec §1):
- The basihyal complex is always the **largest** cohesive bone blob (> any
  stylohyal), so "largest bone-coloured region" finds the target without learning.
- The dataset is taxonomically diverse, so matching is **nearest-of-K exemplars**
  (Euclidean EFA distance), never the mean of them.

Design decisions locked by the 11A spike (§4a) and this module's own de-risking:
- **Detection = colour auto-box → SAM box-predict.** Bones are browner/more
  saturated than the neutral museum backgrounds (gray / white paper / lavender
  mat); classical border-init foreground was rejected (grabs warm surfaces). The
  colour box IS the crop and the SAM prompt — one gesture does crop + isolation.
- **Border-touching rejection** drops blobs hugging the frame edge, which fixes
  the mat/concrete-edge case cheaply and flags (rather than silently grabs) the
  warm-background failures (concrete floors ≈ bone colour).
- **Angle recovery uses the EFA first-harmonic phase (psi_1).** Verified here:
  pyefd's normalized-EFA ``psi_1`` recovers the rotation exactly *mod 180°*, and
  the normalized coefficients preserve the 180° flip, so the flip is resolved by
  picking the orientation whose normalized EFA is closest to the matched
  exemplar's. A PCA long-axis fallback (:func:`recover_angle_pca`) is provided but
  was not needed on the de-risking set.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np

from . import processing
from .analysis import compute_efa

# ---------------------------------------------------------------------------
# Calibrated constants  (spec §3 "Constants" + §4a spike thresholds).
# These are the tunable knobs; they are set empirically by
# ``scripts/calibrate_autodetect.py`` on the real dorsal set, not buried inline.
# ---------------------------------------------------------------------------

# --- Bone colour, in OpenCV HSV (H ∈ [0,179], S,V ∈ [0,255]). ---
# Brown/tan hue band + a saturation floor separates bone from the neutral
# (gray / white-paper / lavender) museum backgrounds. Values from the §4a spike.
BONE_HUE_MIN = 5
BONE_HUE_MAX = 35
BONE_SAT_MIN = 45
BONE_VAL_MIN = 40
BONE_VAL_MAX = 245

# --- Box / region geometry. ---
CROP_MARGIN_FRAC = 0.06        # margin added around the blob bbox (spec §3)
MIN_REGION_FRAC = 0.004        # ignore colour specks below this frac of the frame
MORPH_KERNEL_FRAC = 0.010      # morphology kernel size as frac of the min frame dim
BORDER_TOUCH_FRAC = 0.006      # a blob within this frac of any edge = "border-touching"
FRAME_FILL_REJECT = 0.85       # selected blob bbox filling > this frac = warm-bg failure

# --- SAM mask sanity (spec §4 step 3). ---
SOLIDITY_REJECT = 0.93         # near-rectangular high-solidity mask = scale card
MASK_FILL_BOX_REJECT = 0.92    # mask filling ~the whole box (with high solidity) = grab
SAM_SCORE_REJECT = 0.70        # SAM predicted-IoU below this = SAM is unsure of the box
                               # contents. Calibrated on the dorsal set: every clean bone
                               # scored ≥0.81; the one warm-background garbage grab
                               # (237567, a boxed cart pole) scored 0.43. See §4a.

# --- EFA matching (spec §3). ---
MATCH_HARMONICS = 8            # harmonics for the match key + angle recovery
# τ — flag low_confidence above this. Calibrated on the dorsal set (§5): with 12
# diverse primed exemplars, held-out matched distances were median 0.13, p75 0.23,
# p90 0.42, max 1.03. τ=0.35 sits just above the knee — it passes the ~85% that
# match a primed shape closely and flags the genuinely-novel-shape tail (e.g. the
# unfused/partial specimens) for manual review. Re-tune once a denser, human-
# oriented exemplar set exists (11C) — the distribution tightens.
MATCH_DISTANCE_THRESHOLD = 0.35
ANCHOR_SIMPLIFY_TARGET = 30    # control points for the auto anchor path

DEFAULT_OUTLINE_POINTS = processing.DEFAULT_OUTLINE_POINTS


# ---------------------------------------------------------------------------
# Result records
# ---------------------------------------------------------------------------


@dataclass
class DetectionResult:
    """Output of :func:`detect_target_box`.

    ``box`` is ``(x1, y1, x2, y2)`` in raw-photo pixels (margin-added), or ``None``
    when detection failed. ``flag_reason`` is an internal detail; Phase 11B maps
    both non-``None`` reasons onto ``AutoResult.flagReason == "detection_failed"``.
    """

    box: Optional[tuple[int, int, int, int]]
    flagged: bool
    flag_reason: Optional[str]  # "no_bone_colour" | "warm_background" | None
    fill_frac: float            # selected blob bbox area / frame area
    n_candidate_regions: int    # colour regions surviving border + size rejection


@dataclass
class SegmentationResult:
    """Output of :func:`segment_in_box`. Coordinates in the *cropped* (box) frame."""

    mask: Optional[np.ndarray]         # bool HxW in the cropped frame
    outline: Optional[np.ndarray]      # dense (N, 2) closed outline, cropped frame
    anchor_path: Optional[np.ndarray]  # simplified (M, 2) control points
    solidity: float
    fill_frac: float                   # mask area / box area
    score: float                       # SAM predicted IoU
    flagged: bool
    flag_reason: Optional[str]         # "segmentation_failed" | "scale_card" | None


@dataclass
class Exemplar:
    """A fully-processed primed training specimen (spec §3 ``Exemplar``).

    ``outline`` (the oriented, cropped mask outline) is retained alongside the
    normalized ``efa_coeffs`` because angle recovery needs the outline's
    first-harmonic phase, which the rotation-normalized coefficients discard.
    """

    record_key: str
    crop_box: tuple[int, int, int, int]  # raw-photo frame (crop-before-orient, §6)
    angle_deg: float                     # orientation the user set
    anchor_path: np.ndarray              # (M, 2) mask outline control points
    outline: np.ndarray                  # (N, 2) dense oriented outline (match/angle)
    efa_coeffs: np.ndarray               # normalized EFA (MATCH_HARMONICS, 4) — match key


@dataclass
class MatchResult:
    """Output of :func:`match_nearest_exemplar`."""

    exemplar: Optional[Exemplar]
    distance: float
    flagged: bool  # True => low_confidence (distance > τ)


@dataclass
class AutoOutcome:
    """Everything :func:`run_auto` produces for one photo — the Phase 11B payload."""

    record_key: Optional[str]
    detection: DetectionResult
    segmentation: Optional[SegmentationResult]
    match: Optional[MatchResult]
    angle_deg: Optional[float]
    flip_confidence: Optional[float]     # margin between the two flip candidates
    flagged: bool
    flag_reason: Optional[str]           # "detection_failed" | "low_confidence" | None


# ---------------------------------------------------------------------------
# Small geometry / EFA helpers
# ---------------------------------------------------------------------------


def _rotate_points(points: np.ndarray, deg: float) -> np.ndarray:
    """Rotate (N, 2) points about their centroid by ``deg`` (CCW in outline coords).

    Used for angle recovery + flip testing; keeping the centroid fixed makes the
    result translation-stable so EFA (which is translation-normalized anyway)
    compares cleanly.
    """
    a = np.radians(deg)
    c, s = np.cos(a), np.sin(a)
    R = np.array([[c, -s], [s, c]])
    centroid = points.mean(axis=0)
    return (points - centroid) @ R.T + centroid


def normalized_efa(outline: np.ndarray, harmonics: int = MATCH_HARMONICS) -> np.ndarray:
    """Normalized EFA coefficients (the match key) for a closed outline."""
    return compute_efa(outline, harmonics=harmonics, normalize=True)


def first_harmonic_phase(outline: np.ndarray) -> float:
    """The orientation (radians, in ``[0, π)``) of the outline's fundamental ellipse.

    This is pyefd's ``psi_1`` normalization parameter. It tracks the shape's
    rotation exactly, modulo the 180° ellipse symmetry — the basis for
    :func:`recover_angle`.
    """
    import pyefd

    _, (_size, psi_1, _theta_1) = pyefd.elliptic_fourier_descriptors(
        np.asarray(outline, dtype=np.float64),
        order=1,
        normalize=True,
        return_transformation=True,
    )
    return float(psi_1)


def efa_distance(a: np.ndarray, b: np.ndarray) -> float:
    """Euclidean distance between two normalized EFA coefficient blocks."""
    return float(np.linalg.norm(np.asarray(a).ravel() - np.asarray(b).ravel()))


# ---------------------------------------------------------------------------
# 1. detect_target_box — colour auto-box
# ---------------------------------------------------------------------------


def bone_colour_mask(image_rgb: np.ndarray) -> np.ndarray:
    """Boolean mask of bone-coloured pixels (brown/tan hue + saturation floor)."""
    import cv2

    hsv = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2HSV)
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    return (
        (h >= BONE_HUE_MIN)
        & (h <= BONE_HUE_MAX)
        & (s >= BONE_SAT_MIN)
        & (v >= BONE_VAL_MIN)
        & (v <= BONE_VAL_MAX)
    )


def detect_target_box(
    image_rgb: np.ndarray, margin_frac: float = CROP_MARGIN_FRAC
) -> DetectionResult:
    """Auto-box the target bone by colour (zero-touch path, spec §4 step 1).

    Colour-mask candidate bone regions → morphology cleanup → connected components
    → drop tiny + border-touching blobs → take the **largest** survivor (domain
    fact: basihyal complex > stylohyals) → its bbox + margin.

    Flags (returns ``box=None`` or ``flagged=True``) when:
    - no bone-coloured region survives → ``no_bone_colour`` (detection failed), or
    - the selected region fills > ``FRAME_FILL_REJECT`` of the frame →
      ``warm_background`` (the concrete-floor failure: warm surface ≈ bone colour).

    Border-touching rejection is what lets the neutral-background majority isolate
    the bone while the warm-background minority flags for a manual box, rather than
    silently boxing the floor (§4a).
    """
    import cv2
    from skimage import measure

    h, w = image_rgb.shape[:2]
    frame_area = float(h * w)

    colour = bone_colour_mask(image_rgb).astype(np.uint8)

    # Morphology: open to drop speckle, close to consolidate the bone body.
    k = max(3, int(min(h, w) * MORPH_KERNEL_FRAC))
    if k % 2 == 0:
        k += 1
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    cleaned = cv2.morphologyEx(colour, cv2.MORPH_OPEN, kernel)
    cleaned = cv2.morphologyEx(cleaned, cv2.MORPH_CLOSE, kernel)

    labels = measure.label(cleaned, connectivity=2)
    if labels.max() == 0:
        return DetectionResult(None, True, "no_bone_colour", 0.0, 0)

    border = max(1, int(min(h, w) * BORDER_TOUCH_FRAC))
    kept = []
    for region in measure.regionprops(labels):
        if region.area / frame_area < MIN_REGION_FRAC:
            continue
        min_r, min_c, max_r, max_c = region.bbox
        touches_edge = (
            min_r <= border
            or min_c <= border
            or max_r >= h - border
            or max_c >= w - border
        )
        if touches_edge:
            continue
        kept.append(region)

    if not kept:
        # Everything bone-coloured hugged an edge (warm background / surface grab)
        # or was speckle — flag rather than box the floor.
        return DetectionResult(None, True, "no_bone_colour", 0.0, 0)

    target = max(kept, key=lambda r: r.area)
    min_r, min_c, max_r, max_c = target.bbox
    box_w, box_h = (max_c - min_c), (max_r - min_r)
    fill_frac = (box_w * box_h) / frame_area

    long_axis = max(box_w, box_h)
    margin = int(long_axis * margin_frac)
    x1 = max(0, min_c - margin)
    y1 = max(0, min_r - margin)
    x2 = min(w, max_c + margin)
    y2 = min(h, max_r + margin)

    if fill_frac > FRAME_FILL_REJECT:
        return DetectionResult(
            (x1, y1, x2, y2), True, "warm_background", fill_frac, len(kept)
        )

    return DetectionResult((x1, y1, x2, y2), False, None, fill_frac, len(kept))


# ---------------------------------------------------------------------------
# 1b. detect_target_box_learned — prime-learned appearance detector
# ---------------------------------------------------------------------------

APPEARANCE_BINS = 16              # per-channel Lab histogram resolution
APPEARANCE_FG_THRESHOLD = 0.6     # pixel is foreground when P(target) exceeds this
APPEARANCE_BG_THRESHOLD = 0.30    # pixel is confident background below this P(target)
LEARNED_CROP_MARGIN_FRAC = 0.05   # box margin for the learned path (see note below)
_APPEARANCE_BG_SAMPLE = 60_000    # cap background pixels sampled per exemplar
_POS_PROMPT_POINTS = 4            # SAM positive points seeded inside the target blob
_NEG_PROMPT_POINTS = 6            # SAM negative points seeded on background (+ 4 corners)
_CENTER_PROMPT_OFFSET = 0.20      # off-centre positive-point ring, as a fraction of box size


@dataclass
class AppearanceModel:
    """A target-vs-background colour model learned from the primed masks.

    ``lut`` is a ``(bins, bins, bins)`` table of P(target) per coarse Lab colour
    bin, learned from foreground pixels inside the primed outlines versus
    background pixels outside the primed crops. This is what makes detection
    domain-agnostic: priming teaches the tool what the target looks like, so no
    fixed colour band is needed. See :func:`detect_target_box_learned`.
    """

    lut: np.ndarray
    bins: int = APPEARANCE_BINS


def _lab_bins(image_rgb: np.ndarray, bins: int) -> np.ndarray:
    """Coarse Lab bin index per pixel: same trailing shape as input, last dim 3."""
    import cv2

    lab = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2LAB).astype(np.int32)
    return np.clip(lab * bins // 256, 0, bins - 1)


def _accumulate_hist(hist: np.ndarray, pixels: np.ndarray, bins: int) -> None:
    if pixels.size == 0:
        return
    idx = _lab_bins(pixels.reshape(-1, 1, 3), bins).reshape(-1, 3)
    np.add.at(hist, (idx[:, 0], idx[:, 1], idx[:, 2]), 1.0)


def build_appearance_model(
    samples: list[tuple[np.ndarray, tuple[int, int, int, int], np.ndarray]],
    bins: int = APPEARANCE_BINS,
) -> Optional["AppearanceModel"]:
    """Learn a target/background colour model from primed (image, crop, polygon)s.

    ``polygon`` is the box-frame mask outline (the exemplar ``anchor_path``).
    Foreground = pixels inside it; background = pixels outside the crop box, which
    captures whatever the specimen sits on, including annotation or scale bars.
    Returns ``None`` if no usable foreground is found (caller falls back to the
    colour heuristic).
    """
    import cv2

    fg = np.zeros((bins, bins, bins), dtype=np.float64)
    bg = np.zeros((bins, bins, bins), dtype=np.float64)
    for image_rgb, crop_box, polygon in samples:
        h, w = image_rgb.shape[:2]
        x1, y1, x2, y2 = (int(v) for v in crop_box)
        x1, y1, x2, y2 = max(0, x1), max(0, y1), min(w, x2), min(h, y2)
        if x2 <= x1 or y2 <= y1:
            continue
        crop = image_rgb[y1:y2, x1:x2]
        pts = np.round(np.asarray(polygon, dtype=np.float64)).astype(np.int32)
        if pts.shape[0] < 3:
            continue
        mask = np.zeros(crop.shape[:2], dtype=np.uint8)
        cv2.fillPoly(mask, [pts], 1)
        _accumulate_hist(fg, crop[mask == 1], bins)

        outside = np.ones((h, w), dtype=bool)
        outside[y1:y2, x1:x2] = False
        bg_pixels = image_rgb[outside]
        if bg_pixels.shape[0] > _APPEARANCE_BG_SAMPLE:
            sel = np.linspace(0, bg_pixels.shape[0] - 1, _APPEARANCE_BG_SAMPLE).astype(int)
            bg_pixels = bg_pixels[sel]
        _accumulate_hist(bg, bg_pixels, bins)

    if fg.sum() == 0:
        return None
    fg /= fg.sum()
    if bg.sum() > 0:
        bg /= bg.sum()
    eps = 1e-6
    return AppearanceModel(lut=(fg + eps) / (fg + bg + 2 * eps), bins=bins)


def detect_target_box_learned(
    image_rgb: np.ndarray,
    model: "AppearanceModel",
    margin_frac: float = LEARNED_CROP_MARGIN_FRAC,
) -> DetectionResult:
    """Auto-box the target using the prime-learned appearance model.

    Mirrors :func:`detect_target_box` but replaces the fixed bone-colour test with
    the learned per-pixel P(target): threshold → morphology → connected components
    → best by size-and-centrality → padded bbox. Flags when no target-like region
    survives (``no_target``) or the region fills the frame (``fill_reject``).

    The box hugs the specimen (modest ``margin_frac``, high P(target) threshold) but
    does not need to be razor-tight: :func:`appearance_point_prompts` seeds SAM with
    positive/negative points from the same P(target) map, which is what actually stops
    SAM grabbing the crop rectangle on low-contrast specimens. Confirmed on the
    translucent foraminifera set.
    """
    import cv2
    from skimage import measure

    h, w = image_rgb.shape[:2]
    frame_area = float(h * w)

    idx = _lab_bins(image_rgb, model.bins)
    like = model.lut[idx[..., 0], idx[..., 1], idx[..., 2]]
    fg = (like > APPEARANCE_FG_THRESHOLD).astype(np.uint8)

    k = max(3, int(min(h, w) * MORPH_KERNEL_FRAC))
    if k % 2 == 0:
        k += 1
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    cleaned = cv2.morphologyEx(fg, cv2.MORPH_OPEN, kernel)
    cleaned = cv2.morphologyEx(cleaned, cv2.MORPH_CLOSE, kernel)

    labels = measure.label(cleaned, connectivity=2)
    if labels.max() == 0:
        return DetectionResult(None, True, "no_target", 0.0, 0)

    kept = [
        r for r in measure.regionprops(labels)
        if r.area / frame_area >= MIN_REGION_FRAC
    ]
    if not kept:
        return DetectionResult(None, True, "no_target", 0.0, 0)

    cx, cy = w / 2.0, h / 2.0

    def score(region):
        min_r, min_c, max_r, max_c = region.bbox
        bxc, byc = (min_c + max_c) / 2.0, (min_r + max_r) / 2.0
        dist = ((bxc - cx) / w) ** 2 + ((byc - cy) / h) ** 2
        return region.area * (1.0 - dist)

    target = max(kept, key=score)
    min_r, min_c, max_r, max_c = target.bbox
    box_w, box_h = (max_c - min_c), (max_r - min_r)
    fill_frac = (box_w * box_h) / frame_area

    long_axis = max(box_w, box_h)
    margin = int(long_axis * margin_frac)
    x1 = max(0, min_c - margin)
    y1 = max(0, min_r - margin)
    x2 = min(w, max_c + margin)
    y2 = min(h, max_r + margin)

    if fill_frac > FRAME_FILL_REJECT:
        return DetectionResult((x1, y1, x2, y2), True, "fill_reject", fill_frac, len(kept))
    return DetectionResult((x1, y1, x2, y2), False, None, fill_frac, len(kept))


def appearance_point_prompts(
    image_rgb: np.ndarray,
    box: tuple[int, int, int, int],
    model: "AppearanceModel",
) -> tuple[Optional[np.ndarray], Optional[np.ndarray]]:
    """Positive/negative SAM point prompts from the learned P(target) map inside ``box``.

    This is the anti-rectangle fix. A box prompt alone is ambiguous on low-contrast
    specimens, so SAM defaults to the box rectangle or wanders. Here the same primed
    appearance model that found the box also tells SAM *what* to grab: positive points
    at the deepest interior of the target blob (distance-transform peaks, spread apart)
    anchor it on the specimen; negative points at the box corners and on confident-
    background pixels stop it filling the crop or grabbing the surrounding speckle.

    Returns ``(coords Nx2, labels N)`` in image pixels (label 1 = foreground, 0 =
    background), or ``(None, None)`` if no usable target blob is found — the caller then
    keeps the plain box prompt. Fully generic: no target-specific tuning, learned from
    priming.
    """
    import cv2
    from skimage import measure

    h, w = image_rgb.shape[:2]
    x1, y1, x2, y2 = (int(v) for v in box)
    x1, y1, x2, y2 = max(0, x1), max(0, y1), min(w, x2), min(h, y2)
    if x2 - x1 < 4 or y2 - y1 < 4:
        return None, None

    idx = _lab_bins(image_rgb[y1:y2, x1:x2], model.bins)
    like = model.lut[idx[..., 0], idx[..., 1], idx[..., 2]]
    fg = (like > APPEARANCE_FG_THRESHOLD).astype(np.uint8)

    k = max(3, int(min(h, w) * MORPH_KERNEL_FRAC))
    if k % 2 == 0:
        k += 1
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    fg = cv2.morphologyEx(fg, cv2.MORPH_OPEN, kernel)
    fg = cv2.morphologyEx(fg, cv2.MORPH_CLOSE, kernel)

    labels = measure.label(fg)
    if labels.max() == 0:
        return None, None
    best = max(measure.regionprops(labels), key=lambda r: r.area)
    blob = (labels == best.label).astype(np.uint8)

    # POSITIVE: deepest-interior points, suppressed after each pick so they spread out.
    dist = cv2.distanceTransform(blob, cv2.DIST_L2, 5)
    work = dist.copy()
    pos: list[tuple[int, int]] = []
    for _ in range(_POS_PROMPT_POINTS):
        _, mx, _, loc = cv2.minMaxLoc(work)
        if mx <= 1.0:
            break
        pos.append((loc[0] + x1, loc[1] + y1))
        cv2.circle(work, loc, int(mx), 0, -1)
    if not pos:
        return None, None

    # NEGATIVE: the four box corners (where SAM grabs) + confident-background samples.
    neg: list[tuple[int, int]] = [
        (x1 + 1, y1 + 1), (x2 - 1, y1 + 1), (x1 + 1, y2 - 1), (x2 - 1, y2 - 1)
    ]
    bg = (like < APPEARANCE_BG_THRESHOLD) & (blob == 0)
    ys, xs = np.where(bg)
    if len(xs):
        sel = np.linspace(0, len(xs) - 1, min(_NEG_PROMPT_POINTS, len(xs))).astype(int)
        neg += [(int(xs[i] + x1), int(ys[i] + y1)) for i in sel]

    coords = np.array(pos + neg, dtype=np.float64)
    labels_arr = np.array([1] * len(pos) + [0] * len(neg), dtype=np.int32)
    return coords, labels_arr


def box_center_prompts(
    box: tuple[int, int, int, int],
) -> tuple[np.ndarray, np.ndarray]:
    """Geometric SAM point prompts for a user-drawn box (Prime/Review — no model yet).

    The user brackets the target, so its CENTRE is foreground and the box CORNERS are
    background. Seeding SAM with a centre + small off-centre ring of positive points and
    the four corners as negatives lets it lock onto the specimen no matter how tight the
    box is drawn — fixing the box-only failure where a snug crop leaves SAM no contrast,
    so it grabs the whole box (then rejected as ``scale_card``) and the user is forced to
    include surrounding clutter. Returns ``(coords Nx2, labels N)`` in image pixels.
    Purely geometric — unlike :func:`appearance_point_prompts` (the Automate path), this
    needs no appearance model, so it works for the very first primed specimen.
    """
    x1, y1, x2, y2 = (int(v) for v in box)
    cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
    dx = int((x2 - x1) * _CENTER_PROMPT_OFFSET)
    dy = int((y2 - y1) * _CENTER_PROMPT_OFFSET)
    pos = [(cx, cy), (cx - dx, cy), (cx + dx, cy), (cx, cy - dy), (cx, cy + dy)]
    neg = [(x1 + 2, y1 + 2), (x2 - 2, y1 + 2), (x1 + 2, y2 - 2), (x2 - 2, y2 - 2)]
    coords = np.array(pos + neg, dtype=np.float64)
    labels = np.array([1] * len(pos) + [0] * len(neg), dtype=np.int32)
    return coords, labels


# ---------------------------------------------------------------------------
# 2. segment_in_box — SAM box-predict → outline → anchor path
# ---------------------------------------------------------------------------


def _solidity(mask: np.ndarray) -> float:
    from skimage import measure

    props = measure.regionprops(mask.astype(np.int32))
    if not props:
        return 0.0
    return float(props[0].solidity)


def segment_in_box(
    image_rgb: np.ndarray,
    box: tuple[int, int, int, int],
    predictor,
    simplify_target: int = ANCHOR_SIMPLIFY_TARGET,
    n_outline_points: int = DEFAULT_OUTLINE_POINTS,
    point_coords: Optional[np.ndarray] = None,
    point_labels: Optional[np.ndarray] = None,
) -> SegmentationResult:
    """SAM box-predict the target bone inside ``box`` (spec §4 step 2–3).

    Uses the box-prompt ``SamPredictor`` (MPS-fast, ~0.5 s) — NOT the automatic
    "segment-everything" generator, which hits a float64 MPS bug (§4a). The mask
    is cropped to the box, so the returned outline/anchor coords live in the
    cropped frame (the crop IS the box, §6). Sanity-rejects a near-rectangular
    high-solidity mask that fills the box (grabbed the scale card) or an empty
    mask, setting ``flagged`` + a reason.

    ``point_coords`` / ``point_labels`` (from :func:`appearance_point_prompts`) add
    positive/negative point prompts alongside the box. On low-contrast specimens the
    box alone is ambiguous and SAM grabs the rectangle; the points give it the signal
    to lock onto the specimen instead. Omitted during priming (no model yet) — the box
    the user drew by hand is enough there.
    """
    x1, y1, x2, y2 = (int(v) for v in box)
    predictor.set_image(image_rgb)
    box_arr = np.array([x1, y1, x2, y2], dtype=np.float32)
    masks, scores, _ = predictor.predict(
        point_coords=point_coords,
        point_labels=point_labels,
        box=box_arr[None, :],
        multimask_output=False,
    )
    score = float(scores[0])

    mask_full = processing.clean_mask(masks[0].astype(bool))
    # Crop to the box so anchor coords are box-relative (the cropped-frame contract).
    mask = mask_full[y1:y2, x1:x2]
    if not mask.any():
        return SegmentationResult(None, None, None, 0.0, 0.0, score, True, "segmentation_failed")

    box_area = float(max(1, (x2 - x1) * (y2 - y1)))
    fill_frac = float(mask.sum()) / box_area
    solidity = _solidity(mask)

    if score < SAM_SCORE_REJECT:
        # SAM is unsure what's in the box — the auto-box landed on clutter, not a
        # clean bone (the warm-background garbage-grab case). Flag for a manual box.
        return SegmentationResult(
            mask, None, None, solidity, fill_frac, score, True, "low_sam_score"
        )

    if solidity >= SOLIDITY_REJECT and fill_frac >= MASK_FILL_BOX_REJECT:
        # Rectangular slab filling the box — the scale card, not a bone.
        return SegmentationResult(
            mask, None, None, solidity, fill_frac, score, True, "scale_card"
        )

    try:
        outline = processing.extract_outline(mask, n_points=n_outline_points)
    except ValueError:
        return SegmentationResult(
            mask, None, None, solidity, fill_frac, score, True, "segmentation_failed"
        )
    anchor_path = processing.simplify_contour(outline, target=simplify_target)
    return SegmentationResult(
        mask, outline, anchor_path, solidity, fill_frac, score, False, None
    )


# ---------------------------------------------------------------------------
# 3. Exemplar model + nearest-of-K matching
# ---------------------------------------------------------------------------


def build_exemplar(
    record_key: str,
    outline: np.ndarray,
    crop_box: tuple[int, int, int, int],
    angle_deg: float,
    anchor_path: Optional[np.ndarray] = None,
    harmonics: int = MATCH_HARMONICS,
) -> Exemplar:
    """Assemble an :class:`Exemplar` from a fully-processed (oriented) outline.

    ``outline`` is the oriented, cropped mask outline (the user-approved shape).
    Its normalized EFA is the match key; the raw outline is retained for angle
    recovery. If ``anchor_path`` is omitted it is derived from the outline.
    """
    outline = np.asarray(outline, dtype=np.float64)
    efa = normalized_efa(outline, harmonics=harmonics)
    if anchor_path is None:
        anchor_path = processing.simplify_contour(outline, target=ANCHOR_SIMPLIFY_TARGET)
    return Exemplar(
        record_key=record_key,
        crop_box=tuple(int(v) for v in crop_box),
        angle_deg=float(angle_deg),
        anchor_path=np.asarray(anchor_path, dtype=np.float64),
        outline=outline,
        efa_coeffs=efa,
    )


def match_nearest_exemplar(
    candidate_efa: np.ndarray,
    exemplars: list[Exemplar],
    candidate_efa_flipped: Optional[np.ndarray] = None,
    threshold: float = MATCH_DISTANCE_THRESHOLD,
) -> MatchResult:
    """Nearest-of-K exemplar by Euclidean EFA distance (spec §4 step 4).

    **Never** the mean of the exemplars — averaging taxonomically distinct shapes
    yields a meaningless template (spec §1). Because normalized EFA is rotation-
    invariant only *modulo the 180° flip*, a candidate photographed at the opposite
    flip would read as far from its true exemplar; pass ``candidate_efa_flipped``
    (the normalized EFA of the 180°-rotated candidate outline) and the distance is
    taken as the min over both flips, making the match flip-invariant.

    Flags ``low_confidence`` when the nearest distance exceeds ``threshold`` (τ).
    """
    if not exemplars:
        return MatchResult(None, float("inf"), True)

    best: Optional[Exemplar] = None
    best_dist = float("inf")
    for ex in exemplars:
        d = efa_distance(candidate_efa, ex.efa_coeffs)
        if candidate_efa_flipped is not None:
            d = min(d, efa_distance(candidate_efa_flipped, ex.efa_coeffs))
        if d < best_dist:
            best_dist = d
            best = ex

    return MatchResult(best, best_dist, best_dist > threshold)


# ---------------------------------------------------------------------------
# 4. Angle recovery
# ---------------------------------------------------------------------------


def recover_angle(
    candidate_outline: np.ndarray,
    exemplar_outline: np.ndarray,
    harmonics: int = MATCH_HARMONICS,
) -> tuple[float, float]:
    """Rotation (degrees) to apply to the candidate outline to match the exemplar's
    orientation, including the 180° flip (spec §4 step 6, risk §10.2).

    Method (verified exact on synthetic pairs): the EFA first-harmonic phase
    ``psi_1`` recovers the rotation modulo 180°; the remaining flip is resolved by
    rotating the candidate to each of the two orientations and picking the one
    whose normalized EFA is closest to the exemplar's (the normalized coefficients
    keep the 180° distinction even though they discard sub-180° rotation).

    Returns ``(angle_deg, flip_confidence)`` where ``angle_deg`` is CCW in outline
    coordinates and ``flip_confidence`` is the normalized-EFA distance gap between
    the rejected and chosen flip (larger = more decisive; ~0 = near-symmetric, the
    flip barely matters).

    NOTE (11B integration): ``angle_deg`` is in outline/image-pixel space. The
    sign against PIL/cv2 ``rotate`` (y-down frame) must be confirmed when wiring
    the auto-orient into the crop-before-orient pipeline; here it is internally
    consistent (rotating the candidate by ``angle_deg`` aligns it to the exemplar).
    """
    candidate_outline = np.asarray(candidate_outline, dtype=np.float64)
    exemplar_outline = np.asarray(exemplar_outline, dtype=np.float64)

    psi_cand = first_harmonic_phase(candidate_outline)
    psi_exem = first_harmonic_phase(exemplar_outline)
    base_deg = np.degrees(psi_exem - psi_cand)

    exem_efa = normalized_efa(exemplar_outline, harmonics=harmonics)
    dists = []
    for flip in (0.0, 180.0):
        rotated = _rotate_points(candidate_outline, base_deg + flip)
        d = efa_distance(normalized_efa(rotated, harmonics=harmonics), exem_efa)
        dists.append((base_deg + flip, d))

    dists.sort(key=lambda t: t[1])
    (best_angle, best_d), (_other_angle, other_d) = dists
    flip_confidence = float(other_d - best_d)
    return float(best_angle % 360.0), flip_confidence


def orient_for_display(points: np.ndarray, display_angle_deg: float) -> np.ndarray:
    """Rotate box-frame ``points`` into the oriented (upright) frame for a display angle.

    The Prime flow captures a *display* angle ``D`` (the PIL/Konva rotation the user
    set so the specimen reads upright) and needs to persist the exemplar's outline in
    that upright frame — the same frame :func:`run_auto` produces for auto-processed
    specimens (``_rotate_points(box_outline, recovered)`` in ``api/automate``). Since
    :func:`to_display_angle` gives ``D = -recovered``, the recovered angle is ``-D`` and
    the oriented outline is ``_rotate_points(points, -D)``.

    This is the exact inverse pinned by :func:`to_display_angle`: an exemplar built from
    an outline oriented here at display ``D`` recovers back to ``D`` when a later
    candidate is matched to it (``to_display_angle(recover_angle(box, oriented)) == D``).
    """
    return _rotate_points(np.asarray(points, dtype=np.float64), -display_angle_deg)


def to_display_angle(recovered_angle_deg: float) -> float:
    """Convert :func:`recover_angle`'s outline-space angle to the PIL/Konva image-
    rotation angle that reorients the specimen (spec §6; angle-sign risk resolved
    in 11B).

    :func:`recover_angle` returns ``α`` such that ``_rotate_points(outline, α)``
    aligns the candidate onto the exemplar in image-**pixel** (y-down) coordinates.
    PIL's ``Image.rotate(θ, expand=True)`` (and the mirroring ``konva/expand.ts``)
    rotate the image CCW in **display** space, which in y-down pixel space equals
    ``_rotate_points(-θ)``. So the image rotation that *realises* the recovered
    ``_rotate_points(α)`` is ``rotate(-α)`` — the display angle is the **negation**
    of the recovered angle. Verified by a mask-IoU round-trip on primed pairs
    (``test_recover_angle_display_sign_reorients``): applying ``-α`` reorients
    (IoU ≈ 0.97), applying ``+α`` mirrors it (IoU ≈ 0.3). Returned in ``[0, 360)``.
    """
    return float((-recovered_angle_deg) % 360.0)


def recover_angle_pca(
    candidate_outline: np.ndarray,
    exemplar_outline: np.ndarray,
    harmonics: int = MATCH_HARMONICS,
) -> tuple[float, float]:
    """PCA long-axis fallback for angle recovery (spec §10.2).

    Aligns the candidate's principal axis to the exemplar's, then resolves the
    180° flip the same way :func:`recover_angle` does (nearest normalized EFA).
    Not used on the de-risking set — the EFA method recovered angles exactly — but
    kept as a documented safety net for shapes where ``psi_1`` is ill-conditioned
    (near-circular outlines with no dominant major axis).
    """
    candidate_outline = np.asarray(candidate_outline, dtype=np.float64)
    exemplar_outline = np.asarray(exemplar_outline, dtype=np.float64)

    def _principal_angle(pts: np.ndarray) -> float:
        c = pts - pts.mean(axis=0)
        cov = np.cov(c, rowvar=False)
        eigvals, eigvecs = np.linalg.eigh(cov)
        v = eigvecs[:, int(np.argmax(eigvals))]
        return float(np.degrees(np.arctan2(v[1], v[0])))

    base_deg = _principal_angle(exemplar_outline) - _principal_angle(candidate_outline)

    exem_efa = normalized_efa(exemplar_outline, harmonics=harmonics)
    dists = []
    for flip in (0.0, 180.0):
        rotated = _rotate_points(candidate_outline, base_deg + flip)
        d = efa_distance(normalized_efa(rotated, harmonics=harmonics), exem_efa)
        dists.append((base_deg + flip, d))
    dists.sort(key=lambda t: t[1])
    (best_angle, best_d), (_a, other_d) = dists
    return float(best_angle % 360.0), float(other_d - best_d)


# ---------------------------------------------------------------------------
# 5. Orchestrator — the full auto pipeline for one photo
# ---------------------------------------------------------------------------


def run_auto(
    image_rgb: np.ndarray,
    exemplars: list[Exemplar],
    predictor,
    record_key: Optional[str] = None,
    harmonics: int = MATCH_HARMONICS,
    appearance_model: Optional["AppearanceModel"] = None,
) -> AutoOutcome:
    """detect → segment → match → recover for one raw photo (spec §4).

    Returns an :class:`AutoOutcome` with the crop box, SAM mask/outline/anchor,
    nearest exemplar + distance, and recovered angle — plus a single top-level
    ``flagged`` / ``flag_reason`` (``detection_failed`` or ``low_confidence``) that
    Review uses to surface the hard cases first. Every stage is fail-soft: a flag
    at any stage short-circuits to a manual-box fallback rather than raising.
    """
    detection = (
        detect_target_box_learned(image_rgb, appearance_model)
        if appearance_model is not None
        else detect_target_box(image_rgb)
    )
    if detection.box is None or detection.flagged:
        return AutoOutcome(
            record_key, detection, None, None, None, None, True, "detection_failed"
        )

    pt_coords = pt_labels = None
    if appearance_model is not None:
        pt_coords, pt_labels = appearance_point_prompts(
            image_rgb, detection.box, appearance_model
        )
    segmentation = segment_in_box(
        image_rgb, detection.box, predictor, point_coords=pt_coords, point_labels=pt_labels
    )
    if segmentation.flagged or segmentation.outline is None:
        return AutoOutcome(
            record_key, detection, segmentation, None, None, None, True, "detection_failed"
        )

    outline = segmentation.outline
    cand_efa = normalized_efa(outline, harmonics=harmonics)
    cand_efa_flipped = normalized_efa(_rotate_points(outline, 180.0), harmonics=harmonics)
    match = match_nearest_exemplar(
        cand_efa, exemplars, candidate_efa_flipped=cand_efa_flipped
    )

    angle_deg: Optional[float] = None
    flip_conf: Optional[float] = None
    if match.exemplar is not None:
        angle_deg, flip_conf = recover_angle(outline, match.exemplar.outline, harmonics)

    flagged = match.flagged or match.exemplar is None
    flag_reason = "low_confidence" if flagged else None
    return AutoOutcome(
        record_key, detection, segmentation, match, angle_deg, flip_conf, flagged, flag_reason
    )


__all__ = [
    "BONE_HUE_MIN",
    "BONE_HUE_MAX",
    "BONE_SAT_MIN",
    "BONE_VAL_MIN",
    "BONE_VAL_MAX",
    "CROP_MARGIN_FRAC",
    "LEARNED_CROP_MARGIN_FRAC",
    "APPEARANCE_FG_THRESHOLD",
    "FRAME_FILL_REJECT",
    "BORDER_TOUCH_FRAC",
    "SOLIDITY_REJECT",
    "MATCH_HARMONICS",
    "MATCH_DISTANCE_THRESHOLD",
    "ANCHOR_SIMPLIFY_TARGET",
    "DetectionResult",
    "SegmentationResult",
    "Exemplar",
    "MatchResult",
    "AutoOutcome",
    "bone_colour_mask",
    "detect_target_box",
    "AppearanceModel",
    "build_appearance_model",
    "detect_target_box_learned",
    "appearance_point_prompts",
    "box_center_prompts",
    "segment_in_box",
    "build_exemplar",
    "match_nearest_exemplar",
    "recover_angle",
    "recover_angle_pca",
    "to_display_angle",
    "orient_for_display",
    "normalized_efa",
    "first_harmonic_phase",
    "efa_distance",
    "run_auto",
]
