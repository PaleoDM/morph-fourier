"""Stage 2 — Prime: the guided per-exemplar flow's backend seam (Phase 11C).

Prime is crop-before-orient (spec §6): the user draws a box on the RAW photo, SAM
box-predicts the target bone inside it, they refine the mask + set the display
angle, and Save assembles an :class:`~app.models.Exemplar`. This module exposes the
three round-trips that flow needs, keeping the EFA math + coordinate geometry on the
backend (so the client only ever ships crop + angle + anchors):

- ``POST /api/{series}/prime/segment`` — SAM box-predict inside a raw-frame box
  (:func:`autodetect.segment_in_box`) → simplified anchor path in the cropped frame.
- ``GET  /api/{series}/prime/{recordKey}/image`` — the cropped raw region as a PNG,
  the background the anchor editor draws on (anchor coords == this image's pixels).
- ``PUT  /api/{series}/prime/exemplar`` — derive the oriented outline + normalized
  ``efaCoeffs`` from the box-frame anchor path + display angle, upsert ``exemplars.json``.
- ``DELETE /api/{series}/prime/exemplar/{recordKey}`` — un-prime a specimen.

The exemplar-set persistence itself lives with the Automate router (``GET/PUT
/exemplars`` in ``api/automate``); this module reuses its (de)serialization helpers
so the two never diverge. ``/segment`` is SAM-gated (503 without the weights file).
"""

from __future__ import annotations

import hashlib
import io
import threading
from collections import OrderedDict

import numpy as np
from fastapi import APIRouter, HTTPException, Request, Response

from .. import autodetect as ad
from .. import models, processing
from ..state import save_state
from . import automate as automate_mod
from . import deps

router = APIRouter(prefix="/api", tags=["prime"])


# ── Cropped-raw-region image cache ──────────────────────────────────────────
# The mask editor + orient puck draw on the cropped raw region; Prime works one
# specimen at a time (not a 48-thumbnail grid), so the load is light, but a raw
# 3–5 MB photo is decoded per request without a cache. A small LRU keyed on
# (recordKey, box, width) + a matching strong ETag collapses repeats to a dict
# lookup / 304. The box is part of the key, so re-drawing the crop mints a fresh
# frame. uvicorn runs sync endpoints in a threadpool → guard with a lock.
_IMAGE_CACHE: "OrderedDict[str, tuple[str, bytes]]" = OrderedDict()
_IMAGE_CACHE_LOCK = threading.Lock()
_IMAGE_CACHE_MAX = 64


def _box_tuple(box: models.CropBox) -> tuple[int, int, int, int]:
    return (int(box.x1), int(box.y1), int(box.x2), int(box.y2))


def _image_cache_key(record_key: str, box: tuple[int, int, int, int], width: int | None) -> str:
    return f"{record_key}|{box}|{width}"


def _image_etag(key: str) -> str:
    return '"' + hashlib.sha256(key.encode("utf-8")).hexdigest()[:32] + '"'


# ── Segment ─────────────────────────────────────────────────────────────────


@router.post("/{series}/prime/segment", response_model=models.SegmentResult)
def prime_segment(series: str, req: models.PrimeSegmentRequest) -> models.SegmentResult:
    """SAM box-predict the target bone inside the user's raw-frame box (spec §4 step 2).

    The box is the crop AND the SAM prompt (one gesture). To keep SAM reliable when the
    box is drawn snug (box-only SAM then grabs the whole rectangle → ``scale_card``, the
    single biggest Prime friction), it is seeded with geometric point prompts from the
    box itself (:func:`autodetect.box_center_prompts`): the centre is the target, the
    corners are background. Returns a simplified anchor path in the *cropped* (box) frame
    — the seed for the pen-tool editor, whose background is the same cropped region served
    by ``/prime/{recordKey}/image``. A box SAM still can't segment (empty / low score) →
    422 so the UI can prompt the user to redraw it.
    """
    rec = deps.get_record(series, req.record_key)
    predictor = deps.get_sam_predictor()  # 503 if weights absent

    image = processing.load_image_rgb(rec.source_path)
    box = _box_tuple(req.box)
    pt_coords, pt_labels = ad.box_center_prompts(box)
    seg = ad.segment_in_box(image, box, predictor, point_coords=pt_coords, point_labels=pt_labels)
    if seg.flagged or seg.outline is None or seg.anchor_path is None:
        raise HTTPException(
            status_code=422,
            detail=(
                "SAM couldn't isolate a clean bone in that box "
                f"({seg.flag_reason or 'segmentation_failed'}). Try nudging the box so the "
                "target sits roughly centred in it."
            ),
        )
    return models.SegmentResult(
        anchor_path=[models.Point(x=float(x), y=float(y)) for x, y in seg.anchor_path],
        outline_point_count=models.DEFAULT_OUTLINE_POINTS,
    )


# ── Cropped image ───────────────────────────────────────────────────────────


@router.get("/{series}/prime/{record_key:path}/image")
def prime_image(
    series: str,
    record_key: str,
    request: Request,
    x1: int,
    y1: int,
    x2: int,
    y2: int,
    w: int | None = None,
) -> Response:
    """Serve the cropped raw region (``[x1,y1,x2,y2]`` in raw-photo pixels) as a PNG.

    This is the background the Prime anchor editor draws on: anchor coordinates from
    ``/prime/segment`` live in exactly this cropped frame, so the editor needs no
    coordinate math. No rotation — Prime masks in the box frame and applies the
    orientation on Save (spec §6). ``?w=`` downscales for display. Strong ETag +
    ``no-cache`` revalidate; an LRU skips re-decoding the raw photo.
    """
    rec = deps.get_record(series, record_key)
    box = (int(x1), int(y1), int(x2), int(y2))
    if box[2] <= box[0] or box[3] <= box[1]:
        raise HTTPException(status_code=400, detail="Box must have x2 > x1 and y2 > y1.")

    key = _image_cache_key(record_key, box, w)
    etag = _image_etag(key)
    headers = {"ETag": etag, "Cache-Control": "no-cache"}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)

    with _IMAGE_CACHE_LOCK:
        cached = _IMAGE_CACHE.get(key)
        if cached is not None:
            _IMAGE_CACHE.move_to_end(key)
            png = cached[1]

    if cached is None:
        # [x, y, w, h] in the raw frame → the crop-before-orient region (no rotation).
        crop_bbox = [box[0], box[1], box[2] - box[0], box[3] - box[1]]
        img = processing.standardized_crop_image(rec, 0.0, crop_bbox, max_width=w)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        png = buf.getvalue()
        with _IMAGE_CACHE_LOCK:
            _IMAGE_CACHE[key] = (etag, png)
            _IMAGE_CACHE.move_to_end(key)
            while len(_IMAGE_CACHE) > _IMAGE_CACHE_MAX:
                _IMAGE_CACHE.popitem(last=False)

    return Response(content=png, media_type="image/png", headers=headers)


# ── Exemplar upsert / delete ────────────────────────────────────────────────


@router.put("/{series}/prime/exemplar", response_model=models.ExemplarSet)
def put_exemplar(series: str, req: models.PrimeExemplarRequest) -> models.ExemplarSet:
    """Assemble + persist one primed exemplar; return the updated set (spec §3 / 11C).

    Backend-derived geometry (client ships only crop + angle + box-frame anchors):
      1. resample the anchor path → dense closed outline (box frame), the same
         authoritative resample the mask PUT uses;
      2. orient both into the upright frame for the display ``angleDeg``
         (:func:`autodetect.orient_for_display`) — the frame ``run_auto`` matches
         against and Stages 5–8 consume;
      3. normalized EFA of the oriented outline = the match key.
    Upserts by ``recordKey`` (re-priming a specimen replaces its exemplar).
    """
    deps.get_series(series)
    rec = deps.get_record(series, req.record_key)  # 404 if not a real record

    anchor_xy = np.array([[p.x, p.y] for p in req.anchor_path], dtype=np.float64)
    if len(anchor_xy) < 3:
        raise HTTPException(status_code=400, detail="anchorPath needs at least 3 points.")

    exemplar_set = automate_mod._load_exemplars(series)

    dense_box = processing.resample_anchor_path(anchor_xy, models.DEFAULT_OUTLINE_POINTS)
    oriented_outline = ad.orient_for_display(dense_box, req.angle_deg)
    oriented_anchor = ad.orient_for_display(anchor_xy, req.angle_deg)

    exemplar = ad.build_exemplar(
        record_key=rec.record_key,
        outline=oriented_outline,
        crop_box=_box_tuple(req.crop_box),
        angle_deg=float(req.angle_deg),
        anchor_path=oriented_anchor,
        harmonics=exemplar_set.harmonics,
    )
    model = automate_mod.exemplar_to_model(exemplar)

    others = [e for e in exemplar_set.exemplars if e.record_key != rec.record_key]
    exemplar_set.exemplars = [*others, model]
    save_state(series, "exemplars", exemplar_set)
    return exemplar_set


@router.delete("/{series}/prime/exemplar/{record_key:path}", response_model=models.ExemplarSet)
def delete_exemplar(series: str, record_key: str) -> models.ExemplarSet:
    """Un-prime a specimen: drop it from the exemplar set. Idempotent (no 404 if absent)."""
    deps.get_series(series)
    exemplar_set = automate_mod._load_exemplars(series)
    exemplar_set.exemplars = [e for e in exemplar_set.exemplars if e.record_key != record_key]
    save_state(series, "exemplars", exemplar_set)
    return exemplar_set
