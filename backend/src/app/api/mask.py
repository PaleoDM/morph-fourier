"""Stage 4 — Mask: SAM outline → simplified anchor path → resampled outline CSV.

``POST /mask/segment`` runs SAM (applying the specimen's Stage-2 angle + Stage-3
crop), extracts a dense outline, and Douglas-Peucker-simplifies it to
``<= ANCHOR_SIMPLIFY_TARGET`` control points — the seed for the pen-tool editor.
``PUT /mask/{recordKey}`` persists the (possibly hand-edited) anchor path,
arc-length-resamples it to ``DEFAULT_OUTLINE_POINTS``, and writes the outline CSV
that Stages 5–8 consume. The full anchor-edit UX is Phase 6; 1B provides the seam.

SAM-gated: ``/segment`` returns 503 if the weights file is absent.
"""

from __future__ import annotations

import hashlib
import io
import os
import threading
from collections import OrderedDict

import numpy as np
import pandas as pd
from fastapi import APIRouter, Request, Response

from .. import models, processing
from ..state import BACKEND_ROOT, derived_dir, load_state, save_state
from . import deps

router = APIRouter(prefix="/api", tags=["mask"])

# ── Standardized-image cache ────────────────────────────────────────────────
# The grid renders one thumbnail per canonical (~48) and Stage 5's gallery will
# reuse the same endpoint, so a cold rotate→crop→(downscale)→encode-PNG of a
# 3–5 MB photo per request saturates the single backend process. A bounded LRU
# keyed on (recordKey, angleDeg, cropBox, width) collapses repeats to a dict
# lookup; the matching strong ETag lets the browser 304 without re-decoding.
#
# Correctness: the key/ETag include the orientation angle AND crop box, so
# re-orienting (Stage 2) or re-cropping (Stage 3) mints a new key — a return to
# Stage 4 regenerates rather than serving a stale frame. Width is in the key too
# (thumb vs full-res are distinct entries). uvicorn runs sync endpoints in a
# threadpool, so the OrderedDict is guarded by a lock.
_IMAGE_CACHE: "OrderedDict[str, tuple[str, bytes]]" = OrderedDict()
_IMAGE_CACHE_LOCK = threading.Lock()
_IMAGE_CACHE_MAX = 128


def _image_cache_key(record_key: str, angle: float, crop_bbox: list[int] | None, width: int | None) -> str:
    return f"{record_key}|{angle:.6f}|{crop_bbox}|{width}"


def _image_etag(key: str) -> str:
    return '"' + hashlib.sha256(key.encode("utf-8")).hexdigest()[:32] + '"'


def _load(series: str) -> models.MaskState:
    raw = load_state(series, "mask")
    if raw is None:
        return models.MaskState(updated_at=deps.now_iso())
    return models.MaskState.model_validate(raw)


def _orientation_angle(series: str, record_key: str) -> float:
    st = load_state(series, "orient", {}) or {}
    entry = st.get("orientations", {}).get(record_key)
    return float(entry["angleDeg"]) if entry else 0.0


def _crop_bbox(series: str, record_key: str) -> list[int] | None:
    st = load_state(series, "crop", {}) or {}
    box = st.get("crops", {}).get(record_key)
    if not box:
        return None
    return [
        int(box["x1"]),
        int(box["y1"]),
        int(box["x2"] - box["x1"]),
        int(box["y2"] - box["y1"]),
    ]


@router.get("/{series}/mask", response_model=models.MaskState)
def get_mask(series: str) -> models.MaskState:
    deps.get_series(series)
    return _load(series)


@router.get("/{series}/mask/{record_key:path}/image")
def standardized_image(
    series: str, record_key: str, request: Request, w: int | None = None
) -> Response:
    """Serve the rotated (Stage 2) + cropped (Stage 3) PNG the anchor editor draws on.

    Anchor coordinates live in exactly this image's pixel frame, so the editor loads
    it as its background with no client-side coordinate math. No SAM — just a
    rotate+crop of the raw photo. (Phase 7's gallery reuses this endpoint.)

    ``?w=<maxWidth>`` downscales the encoded PNG to that width (aspect preserved) for
    the thumbnail grid; the editor omits it to get full resolution. Responses carry a
    strong ETag + ``Cache-Control: no-cache`` (revalidate) so re-opening the stage is
    a cheap 304 when the frame is unchanged, but a re-orient/re-crop (new ETag) serves
    fresh pixels. Server-side, an LRU keyed on the same tuple skips regeneration.
    """
    rec = deps.get_record(series, record_key)
    angle = _orientation_angle(series, record_key)
    crop_bbox = _crop_bbox(series, record_key)

    key = _image_cache_key(record_key, angle, crop_bbox, w)
    etag = _image_etag(key)
    headers = {"ETag": etag, "Cache-Control": "no-cache"}

    # Browser already holds this exact frame → 304, no body, no decode.
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)

    with _IMAGE_CACHE_LOCK:
        cached = _IMAGE_CACHE.get(key)
        if cached is not None:
            _IMAGE_CACHE.move_to_end(key)
            png = cached[1]

    if cached is None:
        img = processing.standardized_crop_image(rec, angle, crop_bbox, max_width=w)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        png = buf.getvalue()
        with _IMAGE_CACHE_LOCK:
            _IMAGE_CACHE[key] = (etag, png)
            _IMAGE_CACHE.move_to_end(key)
            while len(_IMAGE_CACHE) > _IMAGE_CACHE_MAX:
                _IMAGE_CACHE.popitem(last=False)

    return Response(content=png, media_type="image/png", headers=headers)


@router.post("/{series}/mask/segment", response_model=models.SegmentResult)
def segment(series: str, req: models.SegmentRequest) -> models.SegmentResult:
    """Run SAM and return a simplified anchor path for the pen-tool editor."""
    rec = deps.get_record(series, req.record_key)
    predictor = deps.get_sam_predictor()

    angle = _orientation_angle(series, req.record_key)
    crop_bbox = _crop_bbox(series, req.record_key)
    if crop_bbox is None:
        # No crop yet — auto-suggest one so segment works standalone.
        crop_bbox = processing.compute_crop_for_photo(rec, angle, predictor)

    seed_points = [{"x": s.x, "y": s.y, "label": s.label} for s in req.seed_points]
    _mask, outline = processing.compute_mask_for_photo(
        rec,
        angle,
        crop_bbox,
        predictor,
        seed_points=seed_points or None,
        n_outline_points=models.DEFAULT_OUTLINE_POINTS,
    )
    anchors = processing.simplify_contour(outline, target=models.ANCHOR_SIMPLIFY_TARGET)
    return models.SegmentResult(
        anchor_path=[models.Point(x=float(x), y=float(y)) for x, y in anchors],
        outline_point_count=models.DEFAULT_OUTLINE_POINTS,
    )


@router.put("/{series}/mask/{record_key:path}", response_model=models.MaskState)
def save_mask(series: str, record_key: str, req: models.MaskUpdateRequest) -> models.MaskState:
    """Persist the anchor path, resample to an outline CSV, update mask.json."""
    rec = deps.get_record(series, record_key)

    anchor_xy = np.array([[p.x, p.y] for p in req.anchor_path], dtype=np.float64)
    if len(anchor_xy) < 3:
        from fastapi import HTTPException

        raise HTTPException(status_code=400, detail="anchorPath needs at least 3 points.")

    # Authoritative outline = closed centripetal Catmull-Rom through the anchors,
    # arc-length-resampled so EFA gets a smooth, evenly-spaced closed curve rather
    # than a jagged polygon (which would inject spurious high harmonics).
    outline = processing.resample_anchor_path(anchor_xy, models.DEFAULT_OUTLINE_POINTS)

    outlines_dir = derived_dir(series, "outlines")
    outlines_dir.mkdir(parents=True, exist_ok=True)
    csv_path = outlines_dir / f"{rec.specimen_id_safe}.csv"
    pd.DataFrame(outline, columns=["x", "y"]).to_csv(csv_path, index=False)
    # Path is relative to BACKEND_ROOT — clean ("state/{series}/outlines/{safe}.csv")
    # in production; os.path.relpath keeps it invertible (BACKEND_ROOT / rel → csv_path)
    # even when tests redirect the state root outside the backend tree.
    rel_path = os.path.relpath(csv_path, BACKEND_ROOT)

    st = _load(series)
    st.masks[record_key] = models.MaskEntry(
        seed_points=req.seed_points,
        anchor_path=req.anchor_path,
        source=req.source,
        outline_point_count=models.DEFAULT_OUTLINE_POINTS,
        outline_rel_path=rel_path,
    )
    st.updated_at = deps.now_iso()
    save_state(series, "mask", st)
    return st


@router.post("/{series}/mask/lock", response_model=models.MaskState)
def lock_mask(series: str) -> models.MaskState:
    deps.get_series(series)
    st = _load(series)
    st.locked_at = deps.now_iso()
    st.updated_at = st.locked_at
    save_state(series, "mask", st)
    return st
