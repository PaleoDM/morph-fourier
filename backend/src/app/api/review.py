"""Stage 4 — Review & Finalize: the refine seam (Phase 11D).

Review shows every canonical (primed + auto) shape-only and lets the user fix any
of them through the **same box-frame wizard as Prime** (crop → SAM → mask → orient).
Refining is crop-before-orient exactly like priming — the client ships the raw-frame
crop box, the display angle, and the box-frame anchor path — but the result overwrites
the specimen's **crop/orient/mask geometry** (not the exemplar set):

- ``POST /api/{series}/review/refine`` — derive the upright outline + anchor from the
  box-frame anchor path + display angle (:func:`autodetect.orient_for_display`, the
  same geometry Prime uses), write crop + orient + mask (+ the outline CSV) via the
  shared :func:`api.automate.write_geometry`, and stamp the ``AutoResult`` as a
  human ``source="manual"`` (unflagged — a hand-refined specimen is trusted).

The SAM box-predict + cropped-image serving Review's wizard needs are already exposed
generically by the Prime router (``/prime/segment`` + ``/prime/{recordKey}/image``);
this module reuses them, so refine only adds the save path. Reuses the Automate
router's state loaders so the two never diverge.
"""

from __future__ import annotations

import numpy as np
from fastapi import APIRouter, HTTPException

from .. import autodetect as ad
from .. import models, processing
from ..state import save_state
from . import automate as automate_mod
from . import deps

router = APIRouter(prefix="/api", tags=["review"])


@router.post("/{series}/review/refine", response_model=models.AutoResult)
def review_refine(series: str, req: models.PrimeExemplarRequest) -> models.AutoResult:
    """Overwrite one specimen's crop/orient/mask from a box-frame refine (spec §2, Stage 4).

    Same inputs as ``PUT /prime/exemplar`` — a raw-frame crop box, the display angle,
    and a box-frame anchor path — but this writes the analysed geometry state Gallery/
    EFA/PCA consume, not the exemplar set. The specimen's provenance flips to a
    human-refined ``source="manual"`` result (unflagged), so Review re-sorts it out of
    the flagged-first head.
    """
    deps.get_series(series)
    rec = deps.get_record(series, req.record_key)  # 404 if not a real record

    anchor_xy = np.array([[p.x, p.y] for p in req.anchor_path], dtype=np.float64)
    if len(anchor_xy) < 3:
        raise HTTPException(status_code=400, detail="anchorPath needs at least 3 points.")

    # Same box-frame → upright geometry Prime derives (spec §6): resample the anchor
    # path to the dense outline, then rotate both into the display-angle frame.
    dense_box = processing.resample_anchor_path(anchor_xy, models.DEFAULT_OUTLINE_POINTS)
    oriented_outline = ad.orient_for_display(dense_box, req.angle_deg)
    oriented_anchor = ad.orient_for_display(anchor_xy, req.angle_deg)

    crop_st = automate_mod._load_crop(series)
    orient_st = automate_mod._load_orient(series)
    mask_st = automate_mod._load_mask(series)
    auto_st = automate_mod._load_auto_results(series)

    automate_mod.write_geometry(
        series,
        rec,
        crop_box=(req.crop_box.x1, req.crop_box.y1, req.crop_box.x2, req.crop_box.y2),
        crop_source="manual",
        display_angle=float(req.angle_deg),
        orient_source="manual",
        is_priming=False,
        oriented_outline=oriented_outline,
        oriented_anchor=oriented_anchor,
        mask_source="manual",
        crop_st=crop_st,
        orient_st=orient_st,
        mask_st=mask_st,
    )

    result = models.AutoResult(
        record_key=rec.record_key,
        source="manual",
        matched_exemplar_key=None,
        match_distance=None,
        flagged=False,
        flag_reason=None,
        flag_detail=None,
    )
    auto_st.results[rec.record_key] = result

    now = deps.now_iso()
    crop_st.updated_at = orient_st.updated_at = mask_st.updated_at = auto_st.updated_at = now
    save_state(series, "crop", crop_st)
    save_state(series, "orient", orient_st)
    save_state(series, "mask", mask_st)
    save_state(series, "auto_results", auto_st)

    return result
