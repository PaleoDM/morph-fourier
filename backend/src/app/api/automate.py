"""Stage 3 — Automate: exemplar state + the batch auto-detect endpoint (Phase 11B).

Exposes the pure-Python 11A core (:mod:`app.autodetect`) over HTTP and persists
the exemplar set:

- ``GET/PUT /api/{series}/exemplars`` — the ``ExemplarSet`` SSOT (Prime writes it).
- ``POST /api/{series}/automate`` — run :func:`autodetect.run_auto` over every
  non-primed canonical, persist each result into the existing crop/orient/mask
  state **plus** an ``AutoResult`` provenance record, and return count summary.
- ``GET /api/{series}/auto-results`` — the provenance layer Review (11E) reads.

Coordinate frames (spec §6, crop-before-orient; angle sign resolved in 11B):
- ``crop.json`` gets the detection box in **raw-photo** pixels (``source="auto"``).
- ``orient.json`` gets the **display** angle = ``autodetect.to_display_angle(recovered)``
  = the negated recovered angle (the PIL/Konva image rotation that reorients).
- ``mask.json`` + the outline CSV get the **oriented** outline (the box-frame SAM
  outline rotated by the recovered angle) — i.e. coords in the rotated-cropped
  frame, matching the mask contract. The stored outline is the authority Stages
  5–8 consume; the orient angle is metadata describing the frame, so nothing
  double-rotates.

SAM-gated: ``/automate`` returns 503 if the weights file is absent.
"""

from __future__ import annotations

import math
import os
import time

import numpy as np
import pandas as pd
from fastapi import APIRouter

from .. import autodetect as ad
from .. import models, processing
from ..state import BACKEND_ROOT, derived_dir, load_state, save_state
from . import deps

router = APIRouter(prefix="/api", tags=["automate"])


# ---------------------------------------------------------------------------
# Exemplar (de)serialization — autodetect dataclass <-> wire/disk model
# ---------------------------------------------------------------------------


def _points(arr: np.ndarray) -> list[models.Point]:
    return [models.Point(x=float(x), y=float(y)) for x, y in np.asarray(arr)]


def exemplar_to_model(ex: ad.Exemplar) -> models.Exemplar:
    """autodetect :class:`~app.autodetect.Exemplar` → wire/disk :class:`models.Exemplar`."""
    x1, y1, x2, y2 = (int(v) for v in ex.crop_box)
    return models.Exemplar(
        record_key=ex.record_key,
        crop_box=models.CropBox(x1=x1, y1=y1, x2=x2, y2=y2, source="manual"),
        angle_deg=float(ex.angle_deg),
        anchor_path=_points(ex.anchor_path),
        outline=_points(ex.outline),
        efa_coeffs=[[float(v) for v in row] for row in np.asarray(ex.efa_coeffs)],
    )


def model_to_exemplar(m: models.Exemplar) -> ad.Exemplar:
    """wire/disk :class:`models.Exemplar` → autodetect :class:`~app.autodetect.Exemplar`."""
    return ad.Exemplar(
        record_key=m.record_key,
        crop_box=(int(m.crop_box.x1), int(m.crop_box.y1), int(m.crop_box.x2), int(m.crop_box.y2)),
        angle_deg=float(m.angle_deg),
        anchor_path=np.array([[p.x, p.y] for p in m.anchor_path], dtype=np.float64),
        outline=np.array([[p.x, p.y] for p in m.outline], dtype=np.float64),
        efa_coeffs=np.array(m.efa_coeffs, dtype=np.float64),
    )


# ---------------------------------------------------------------------------
# State loaders (default-construct empty state when the file is absent)
# ---------------------------------------------------------------------------


def _load_exemplars(series: str) -> models.ExemplarSet:
    raw = load_state(series, "exemplars")
    if raw is None:
        return models.ExemplarSet(harmonics=ad.MATCH_HARMONICS)
    return models.ExemplarSet.model_validate(raw)


def _load_auto_results(series: str) -> models.AutoResultsState:
    raw = load_state(series, "auto_results")
    if raw is None:
        return models.AutoResultsState(updated_at=deps.now_iso())
    return models.AutoResultsState.model_validate(raw)


def _load_crop(series: str) -> models.CropState:
    raw = load_state(series, "crop")
    return models.CropState(updated_at=deps.now_iso()) if raw is None else models.CropState.model_validate(raw)


def _load_orient(series: str) -> models.OrientState:
    raw = load_state(series, "orient")
    return models.OrientState(updated_at=deps.now_iso()) if raw is None else models.OrientState.model_validate(raw)


def _load_mask(series: str) -> models.MaskState:
    raw = load_state(series, "mask")
    return models.MaskState(updated_at=deps.now_iso()) if raw is None else models.MaskState.model_validate(raw)


# ---------------------------------------------------------------------------
# Exemplar endpoints
# ---------------------------------------------------------------------------


@router.get("/{series}/exemplars", response_model=models.ExemplarSet)
def get_exemplars(series: str) -> models.ExemplarSet:
    deps.get_series(series)
    return _load_exemplars(series)


@router.put("/{series}/exemplars", response_model=models.ExemplarSet)
def put_exemplars(series: str, body: models.ExemplarSet) -> models.ExemplarSet:
    """Persist the exemplar set (Prime writes this after the user primes a spread)."""
    deps.get_series(series)
    save_state(series, "exemplars", body)
    return body


@router.get("/{series}/auto-results", response_model=models.AutoResultsState)
def get_auto_results(series: str) -> models.AutoResultsState:
    deps.get_series(series)
    return _load_auto_results(series)


# ---------------------------------------------------------------------------
# Automate — the batch endpoint
# ---------------------------------------------------------------------------


def _flag_detail(outcome: ad.AutoOutcome) -> str | None:
    """The specific 11A internal reason behind a flag (kept for Review)."""
    det = outcome.detection
    if det is not None and det.flagged and det.flag_reason:
        return det.flag_reason  # no_bone_colour | warm_background
    seg = outcome.segmentation
    if seg is not None and seg.flagged and seg.flag_reason:
        return seg.flag_reason  # low_sam_score | scale_card | segmentation_failed
    return None


def _auto_result(record_key: str, outcome: ad.AutoOutcome) -> models.AutoResult:
    match = outcome.match
    matched_key = match.exemplar.record_key if (match and match.exemplar) else None
    dist = match.distance if match else None
    if dist is not None and not math.isfinite(dist):
        dist = None
    return models.AutoResult(
        record_key=record_key,
        source="auto",
        matched_exemplar_key=matched_key,
        match_distance=dist,
        flagged=outcome.flagged,
        flag_reason=outcome.flag_reason,
        flag_detail=_flag_detail(outcome),
    )


def write_geometry(
    series: str,
    rec,
    *,
    crop_box: tuple[int, int, int, int],
    crop_source: str,
    display_angle: float,
    orient_source: str,
    is_priming: bool,
    oriented_outline: np.ndarray,
    oriented_anchor: np.ndarray,
    mask_source: str,
    crop_st: models.CropState,
    orient_st: models.OrientState,
    mask_st: models.MaskState,
) -> None:
    """Write crop + orient + mask (+ the outline CSV) for one processed specimen.

    The single low-level writer shared by all three producers of geometry state —
    auto-isolation (:func:`_persist_geometry`), primed-exemplar carry-forward
    (:func:`_persist_primed`), and the Review refine endpoint. The outline + anchor
    it is handed are already in the **upright (oriented) frame**; ``display_angle``
    is metadata describing that frame (spec §6), so nothing double-rotates. All
    three write the same ``MaskEntry`` shape the retired Stage-4 mask PUT wrote, so
    Gallery/EFA/PCA consume them unchanged.
    """
    x1, y1, x2, y2 = (int(v) for v in crop_box)
    crop_st.crops[rec.record_key] = models.CropBox(
        x1=x1, y1=y1, x2=x2, y2=y2, source=crop_source
    )
    orient_st.orientations[rec.record_key] = models.Orientation(
        angle_deg=float(display_angle), source=orient_source, is_priming_example=is_priming
    )

    outlines_dir = derived_dir(series, "outlines")
    outlines_dir.mkdir(parents=True, exist_ok=True)
    csv_path = outlines_dir / f"{rec.specimen_id_safe}.csv"
    pd.DataFrame(np.asarray(oriented_outline), columns=["x", "y"]).to_csv(csv_path, index=False)
    rel_path = os.path.relpath(csv_path, BACKEND_ROOT)

    mask_st.masks[rec.record_key] = models.MaskEntry(
        seed_points=[],
        anchor_path=_points(oriented_anchor),
        source=mask_source,
        outline_point_count=int(len(oriented_outline)),
        outline_rel_path=rel_path,
    )


def _persist_geometry(
    series: str,
    rec,
    outcome: ad.AutoOutcome,
    crop_st: models.CropState,
    orient_st: models.OrientState,
    mask_st: models.MaskState,
) -> None:
    """Write crop + orient + mask (+ outline CSV) for one auto-isolated specimen.

    Called only when detection + segmentation produced an outline (even if the
    match flagged ``low_confidence`` — the best guess is still auto-filled and
    surfaced in Review, per spec §5). ``outcome.angle_deg`` may be ``None`` (no
    exemplar matched); then the outline stays in the detected box frame and the
    orient angle is 0 — Review re-orients by hand.
    """
    recovered = outcome.angle_deg  # outline-space CCW angle (or None)
    display_angle = ad.to_display_angle(recovered) if recovered is not None else 0.0

    # Oriented outline: rotate the box-frame SAM outline onto the exemplar's frame
    # (the recovered angle applies via _rotate_points; the display angle is its
    # negation for the image). EFA is rotation-invariant so this doesn't change the
    # match, but it makes the persisted outline (Gallery/Stage-5+ authority) upright.
    box_outline = outcome.segmentation.outline
    oriented = ad._rotate_points(box_outline, recovered) if recovered is not None else box_outline
    anchors = processing.simplify_contour(oriented, target=models.ANCHOR_SIMPLIFY_TARGET)

    write_geometry(
        series,
        rec,
        crop_box=tuple(int(v) for v in outcome.detection.box),
        crop_source="auto",
        display_angle=display_angle,
        orient_source="learned",
        is_priming=False,
        oriented_outline=oriented,
        oriented_anchor=anchors,
        mask_source="auto",
        crop_st=crop_st,
        orient_st=orient_st,
        mask_st=mask_st,
    )


def _persist_primed(
    series: str,
    rec,
    ex: models.Exemplar,
    crop_st: models.CropState,
    orient_st: models.OrientState,
    mask_st: models.MaskState,
) -> None:
    """Carry a primed exemplar's human-made geometry into crop/orient/mask state.

    Prime writes only ``exemplars.json``; without this the hand-curated exemplars —
    the *best* specimens — would be absent from Gallery/EFA/PCA (which read
    mask.json + the outline CSVs). The exemplar already stores the upright outline,
    anchor path, raw-frame crop box, and display angle, so this is a pure carry-
    forward: no SAM, no recomputation. Marked ``is_priming_example`` in orient state.
    """
    outline = np.array([[p.x, p.y] for p in ex.outline], dtype=np.float64)
    anchor = np.array([[p.x, p.y] for p in ex.anchor_path], dtype=np.float64)
    write_geometry(
        series,
        rec,
        crop_box=(ex.crop_box.x1, ex.crop_box.y1, ex.crop_box.x2, ex.crop_box.y2),
        crop_source=ex.crop_box.source,
        display_angle=ex.angle_deg,
        orient_source="manual",
        is_priming=True,
        oriented_outline=outline,
        oriented_anchor=anchor,
        mask_source="manual",
        crop_st=crop_st,
        orient_st=orient_st,
        mask_st=mask_st,
    )


def _clear_geometry(
    record_key: str,
    crop_st: models.CropState,
    orient_st: models.OrientState,
    mask_st: models.MaskState,
) -> None:
    """Drop any prior auto geometry for a specimen that failed detection this run.

    State files are cumulative, so without this a specimen that produced a (bad)
    outline on an earlier run but flags this run would keep the stale outline — and
    Gallery/EFA/PCA read mask.json, so a leftover rectangle would silently pollute
    the analysis. Clearing keeps "flagged" honest: no outline shown, none counted.
    Known-good (primed/manual) records are never in the target loop, so this only
    ever touches auto results.
    """
    crop_st.crops.pop(record_key, None)
    orient_st.orientations.pop(record_key, None)
    mask_st.masks.pop(record_key, None)


def _manual_exemplars(
    manual_keys: list[str],
    harmonics: int,
    crop_st: models.CropState,
    orient_st: models.OrientState,
    mask_st: models.MaskState,
) -> list[ad.Exemplar]:
    """Build exemplars from user-refined ("known good") specimens.

    A specimen the user hand-refined in Review (``source="manual"``) is trusted like
    a primed exemplar: it should sharpen future detection + matching and never be
    re-processed. Its upright outline + anchor already live in mask state (the refine
    endpoint wrote them via :func:`write_geometry`), so this reads them straight back
    into an autodetect :class:`~app.autodetect.Exemplar` — no SAM, no recomputation
    beyond the normalized EFA match key. Records missing any of crop/orient/mask
    state (or an unreadable outline CSV) are skipped rather than half-built.
    """
    out: list[ad.Exemplar] = []
    for rk in manual_keys:
        crop = crop_st.crops.get(rk)
        orient = orient_st.orientations.get(rk)
        mask = mask_st.masks.get(rk)
        if crop is None or orient is None or mask is None or not mask.outline_rel_path:
            continue
        try:
            df = pd.read_csv(BACKEND_ROOT / mask.outline_rel_path)
            outline = df[["x", "y"]].to_numpy(dtype=np.float64)
        except Exception:  # noqa: BLE001 — a missing/garbled outline CSV is simply skipped
            continue
        if len(outline) < 3:
            continue
        anchor = np.array([[p.x, p.y] for p in mask.anchor_path], dtype=np.float64)
        out.append(
            ad.build_exemplar(
                record_key=rk,
                outline=outline,
                crop_box=(crop.x1, crop.y1, crop.x2, crop.y2),
                angle_deg=float(orient.angle_deg),
                anchor_path=anchor if len(anchor) >= 3 else None,
                harmonics=harmonics,
            )
        )
    return out


@router.post("/{series}/automate", response_model=models.AutomateSummary)
def automate(series: str) -> models.AutomateSummary:
    """Run the auto pipeline over every non-primed canonical (spec §4, batch).

    Synchronous: SAM box-predict is ~0.5 s/photo on MPS, so a ~70-photo dorsal set
    is ~1 min. Acceptable for the alpha; a background-task + progress-stream variant
    is a later option if it becomes a UX problem (see CLAUDE.md / mask 503 note).
    """
    ds = deps.get_series(series)
    idx = deps.record_index(ds)

    canon = deps.canonical_record_keys(series)
    canon_set = set(canon)
    exemplar_set = _load_exemplars(series)
    primed_exemplars = [model_to_exemplar(e) for e in exemplar_set.exemplars]
    exemplar_keys = {e.record_key for e in exemplar_set.exemplars}

    crop_st = _load_crop(series)
    orient_st = _load_orient(series)
    mask_st = _load_mask(series)
    auto_st = _load_auto_results(series)

    # "Known good" = specimens the user hand-refined in Review (source="manual").
    # Carlos's rule: anything done manually must count as primed on a re-run and never
    # be overwritten. So a refined specimen (a) feeds the appearance model + nearest-
    # exemplar match like a primed one, and (b) is excluded from the re-processing
    # targets. Its geometry already lives in crop/orient/mask state (refine wrote it),
    # so it's preserved simply by not touching it. Primed takes precedence if both.
    manual_keys = [
        rk
        for rk, r in auto_st.results.items()
        if r.source == "manual" and rk in canon_set and rk not in exemplar_keys
    ]
    manual_exemplars = _manual_exemplars(
        manual_keys, exemplar_set.harmonics, crop_st, orient_st, mask_st
    )
    manual_set = {ex.record_key for ex in manual_exemplars}

    exemplars = [*primed_exemplars, *manual_exemplars]
    known_good = exemplar_keys | manual_set
    targets = [rk for rk in canon if rk not in known_good]

    if not exemplars:
        # Nothing to match against — every specimen would flag. Prime first.
        return models.AutomateSummary(
            series_key=series,
            processed=0,
            primed=0,
            known_good_preserved=0,
            auto_isolated=0,
            matched=0,
            flagged=0,
            flagged_low_confidence=0,
            flagged_detection_failed=0,
            elapsed_seconds=0.0,
            skipped_no_exemplars=True,
        )

    predictor = deps.get_sam_predictor()  # 503 if weights absent

    # Carry each still-canonical primed exemplar's human geometry into crop/orient/
    # mask so the exemplars are first-class members of the analysed set (Gallery/EFA/
    # PCA read mask.json, not exemplars.json). Provenance = source="primed", unflagged.
    primed_count = 0
    for e in exemplar_set.exemplars:
        if e.record_key not in canon_set:
            continue
        rec = idx.get(e.record_key)
        if rec is None:
            continue
        _persist_primed(series, rec, e, crop_st, orient_st, mask_st)
        auto_st.results[e.record_key] = models.AutoResult(
            record_key=e.record_key,
            source="primed",
            matched_exemplar_key=None,
            match_distance=None,
            flagged=False,
            flag_reason=None,
            flag_detail=None,
        )
        primed_count += 1

    # Build the prime-learned appearance model from the exemplar images, so
    # detection adapts to this dataset's target instead of a fixed colour band.
    _samples = []
    for ex in exemplars:
        erec = idx.get(ex.record_key)
        if erec is None:
            continue
        try:
            _samples.append(
                (processing.load_image_rgb(erec.source_path), ex.crop_box, ex.anchor_path)
            )
        except Exception:  # noqa: BLE001 — a missing exemplar image is simply skipped
            continue
    appearance_model = ad.build_appearance_model(_samples) if _samples else None

    auto_isolated = matched = flagged_low = flagged_det = 0
    t0 = time.perf_counter()
    for rk in targets:
        rec = idx[rk]
        try:
            image = processing.load_image_rgb(rec.source_path)
            outcome = ad.run_auto(
                image, exemplars, predictor, record_key=rk, appearance_model=appearance_model
            )
        except Exception as exc:  # noqa: BLE001 — one bad photo must not kill the batch
            # Fail-soft: record a detection_failed result and move on (spec §5).
            _clear_geometry(rk, crop_st, orient_st, mask_st)
            auto_st.results[rk] = models.AutoResult(
                record_key=rk,
                source="auto",
                flagged=True,
                flag_reason="detection_failed",
                flag_detail=f"error: {type(exc).__name__}",
            )
            flagged_det += 1
            continue

        auto_st.results[rk] = _auto_result(rk, outcome)

        has_outline = outcome.segmentation is not None and outcome.segmentation.outline is not None
        if has_outline:
            _persist_geometry(series, rec, outcome, crop_st, orient_st, mask_st)
            auto_isolated += 1
            if not outcome.flagged:
                matched += 1
        else:
            # Detection/segmentation failed → clear any stale outline from a prior run.
            _clear_geometry(rk, crop_st, orient_st, mask_st)

        if outcome.flagged:
            if outcome.flag_reason == "low_confidence":
                flagged_low += 1
            else:
                flagged_det += 1
    elapsed = time.perf_counter() - t0

    now = deps.now_iso()
    crop_st.updated_at = orient_st.updated_at = mask_st.updated_at = auto_st.updated_at = now
    save_state(series, "crop", crop_st)
    save_state(series, "orient", orient_st)
    save_state(series, "mask", mask_st)
    save_state(series, "auto_results", auto_st)

    return models.AutomateSummary(
        series_key=series,
        processed=len(targets),
        primed=primed_count,
        known_good_preserved=len(manual_set),
        auto_isolated=auto_isolated,
        matched=matched,
        flagged=flagged_low + flagged_det,
        flagged_low_confidence=flagged_low,
        flagged_detection_failed=flagged_det,
        elapsed_seconds=round(elapsed, 3),
    )
