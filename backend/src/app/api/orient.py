"""Stage 2 — Orient: manual angles + learned auto-orientation.

State is ``orient.json``. The flagship endpoint is ``POST /orient/build-reference``,
which implements the learned-orientation algorithm (ROADMAP §Phase 4):

  1. Build a reference signature = mean normalized EFA-8 of the hand-oriented
     *priming* specimens (``isPrimingExample = true``).
  2. Auto-orient every remaining canonical: take the mask's long-axis angle θ,
     then pick θ vs θ+180° by nearest distance to the reference (``decide_flip``).

The heavy per-specimen work (SAM → mask → outline) runs synchronously; SAM is
gated (503) when weights are absent.
"""

from __future__ import annotations

import numpy as np
from fastapi import APIRouter, HTTPException

from .. import analysis, models, orientation, processing
from ..state import load_state, save_state
from . import deps

router = APIRouter(prefix="/api", tags=["orient"])

ORIENTATION_OUTLINE_POINTS = 800  # dense enough for a stable EFA-8 signature


def _load(series: str) -> models.OrientState:
    raw = load_state(series, "orient")
    if raw is None:
        return models.OrientState(updated_at=deps.now_iso())
    return models.OrientState.model_validate(raw)


def _cleaned_mask(rec, predictor) -> np.ndarray:
    image = processing.load_image_rgb(rec.source_path)
    raw_mask, _ = processing.segment_with_sam(predictor, image)
    return processing.clean_mask(raw_mask)


def _outline_at_angle(rec, angle_deg: float, predictor) -> np.ndarray | None:
    """Segment the raw photo, rotate the mask by ``angle_deg``, return its outline."""
    image = processing.load_image_rgb(rec.source_path)
    raw_mask, _ = processing.segment_with_sam(predictor, image)
    mask = processing.clean_mask(raw_mask)
    if not mask.any():
        return None
    if angle_deg:
        _, mask = processing.rotate_image_and_mask(image, mask, angle_deg)
    if not mask.any():
        return None
    return processing.extract_outline(mask, n_points=ORIENTATION_OUTLINE_POINTS)


@router.get("/{series}/orient", response_model=models.OrientState)
def get_orient(series: str) -> models.OrientState:
    deps.get_series(series)
    return _load(series)


@router.put("/{series}/orient/{record_key:path}", response_model=models.OrientState)
def set_orientation(
    series: str, record_key: str, orientation_in: models.Orientation
) -> models.OrientState:
    """Persist one manual orientation (a user puck-drag → ``source = manual``)."""
    deps.get_record(series, record_key)
    st = _load(series)
    st.orientations[record_key] = orientation_in
    st.updated_at = deps.now_iso()
    save_state(series, "orient", st)
    return st


@router.post("/{series}/orient/build-reference", response_model=models.OrientState)
def build_reference_and_auto_orient(series: str) -> models.OrientState:
    """Build the learned reference from priming examples, then auto-orient the rest."""
    ds = deps.get_series(series)
    idx = deps.record_index(ds)
    predictor = deps.get_sam_predictor()

    st = _load(series)
    canon = deps.canonical_record_keys(series)
    harmonics = orientation.DEFAULT_ORIENTATION_HARMONICS

    # 1. Reference from every hand-set (source == "manual") canonical. This is the
    #    authoritative priming set: it covers both the initial priming examples and
    #    any later manual corrections, so "rebuild & re-run" re-primes from all
    #    current manual orientations (ROADMAP §Phase 4 step 5). ``isPrimingExample``
    #    is a UI marker for the priming-progress counter, not the selector here.
    priming_keys = [
        rk
        for rk, o in st.orientations.items()
        if o.source == "manual" and rk in idx and rk in canon
    ]
    oriented: list[np.ndarray] = []
    used_keys: list[str] = []
    for rk in priming_keys:
        outline = _outline_at_angle(idx[rk], st.orientations[rk].angle_deg, predictor)
        if outline is not None:
            oriented.append(outline)
            used_keys.append(rk)

    if not oriented:
        # Nothing to prime from — return state unchanged with a clear (empty) reference.
        st.updated_at = deps.now_iso()
        save_state(series, "orient", st)
        return st

    reference = orientation.build_reference(oriented, harmonics=harmonics)
    st.learned_reference = models.LearnedReference(
        priming_record_keys=used_keys,
        reference_coeffs=[float(v) for v in reference],
        harmonics_used=harmonics,
        built_at=deps.now_iso(),
    )

    # 2. Auto-orient every non-priming canonical.
    for rk in canon:
        if rk in priming_keys or rk not in idx:
            continue
        rec = idx[rk]
        mask = _cleaned_mask(rec, predictor)
        if not mask.any():
            continue
        base_angle = processing.mask_principal_angle_degrees(mask)
        outline = _outline_at_angle(rec, base_angle, predictor)
        if outline is None:
            continue
        decision = orientation.decide_flip(outline, reference, harmonics=harmonics)
        angle = (base_angle + decision["angleOffsetDeg"]) % 360.0
        st.orientations[rk] = models.Orientation(
            angle_deg=float(angle), source="learned", is_priming_example=False
        )

    st.updated_at = deps.now_iso()
    save_state(series, "orient", st)
    return st


@router.get("/{series}/orient/reference-preview", response_model=models.ReconstructResult)
def reference_preview(series: str) -> models.ReconstructResult:
    """Reconstruct the learned "up" outline from the reference signature.

    The mean normalized EFA-8 vector in ``LearnedReference`` is inverse-EFA'd back
    to a closed outline so the user can eyeball that the learned orientation is
    sensible before applying it (ROADMAP §Phase 4 step 5). 404 until a reference
    has been built.
    """
    deps.get_series(series)
    st = _load(series)
    ref = st.learned_reference
    if ref is None:
        raise HTTPException(
            status_code=404, detail="No learned reference yet — build one first."
        )
    coeffs = np.asarray(ref.reference_coeffs, dtype=np.float64).reshape(ref.harmonics_used, 4)
    outline = analysis.reconstruct_outline(coeffs, locus=(0.0, 0.0), n_points=300)
    return models.ReconstructResult(
        outline=[models.Point(x=float(x), y=float(y)) for x, y in outline],
        power_spectrum=None,
    )


@router.post("/{series}/orient/lock", response_model=models.OrientState)
def lock_orient(series: str) -> models.OrientState:
    deps.get_series(series)
    st = _load(series)
    st.locked_at = deps.now_iso()
    st.updated_at = st.locked_at
    save_state(series, "orient", st)
    return st
