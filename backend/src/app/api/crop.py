"""Stage 3 — Crop: 8-handle bounding box in rotated-image coordinates.

State is ``crop.json``. ``POST /crop/auto`` computes a tight mask-bbox + margin for
every canonical (in the rotated frame, using each specimen's Stage-2 angle);
``PUT /crop/{recordKey}`` persists a hand-dragged box. SAM-gated (503 without weights).
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Query

from .. import models, processing
from ..state import load_state, save_state
from . import deps

router = APIRouter(prefix="/api", tags=["crop"])


def _load(series: str) -> models.CropState:
    raw = load_state(series, "crop")
    if raw is None:
        return models.CropState(updated_at=deps.now_iso())
    return models.CropState.model_validate(raw)


def _orientation_angle(series: str, record_key: str) -> float:
    st = load_state(series, "orient", {}) or {}
    entry = st.get("orientations", {}).get(record_key)
    return float(entry["angleDeg"]) if entry else 0.0


@router.get("/{series}/crop", response_model=models.CropState)
def get_crop(series: str) -> models.CropState:
    deps.get_series(series)
    return _load(series)


@router.post("/{series}/crop/auto", response_model=models.CropState)
def auto_crop(
    series: str,
    record_key: Optional[str] = Query(
        default=None,
        alias="recordKey",
        description="Suggest for just this canonical; omit to (re)suggest for all.",
    ),
) -> models.CropState:
    """Auto-suggest a crop box from each canonical's cleaned mask bbox.

    ``record_key`` set → only that canonical (the per-thumb "Auto-suggest this one");
    omitted → every canonical (the "Auto-suggest all" button). Either way the box is
    in the rotated-AND-expanded frame (each record's Stage-2 angle applied), matching
    what ``CropBox.tsx`` renders and what Stage 4 will crop.
    """
    ds = deps.get_series(series)
    idx = deps.record_index(ds)

    # Resolve targets (and 404 on a bad record_key) before loading SAM — keeps the
    # error path cheap and weight-free.
    if record_key is not None:
        deps.get_record(series, record_key)  # 404 if it isn't a real record
        targets = [record_key]
    else:
        targets = deps.canonical_record_keys(series)

    predictor = deps.get_sam_predictor()
    st = _load(series)
    for rk in targets:
        rec = idx.get(rk)
        if rec is None:
            continue
        angle = _orientation_angle(series, rk)
        x, y, w, h = processing.compute_crop_for_photo(rec, angle, predictor)
        st.crops[rk] = models.CropBox(
            x1=float(x), y1=float(y), x2=float(x + w), y2=float(y + h), source="auto"
        )
    st.updated_at = deps.now_iso()
    save_state(series, "crop", st)
    return st


@router.put("/{series}/crop/{record_key:path}", response_model=models.CropState)
def set_crop(series: str, record_key: str, box: models.CropBox) -> models.CropState:
    deps.get_record(series, record_key)
    st = _load(series)
    st.crops[record_key] = box
    st.updated_at = deps.now_iso()
    save_state(series, "crop", st)
    return st


@router.post("/{series}/crop/lock", response_model=models.CropState)
def lock_crop(series: str) -> models.CropState:
    deps.get_series(series)
    st = _load(series)
    st.locked_at = deps.now_iso()
    st.updated_at = st.locked_at
    save_state(series, "crop", st)
    return st
