"""Stage 5 — Export: write a Momocs-style bundle for the series' outlines.

``POST /export`` walks the canonical set and, for every specimen that is fully
ready (has a stored orientation + crop + a saved mask outline), writes three
things under ``state/{seriesKey}/out/``:

  • ``images/{safe}.png``   — the standardized rotated (Stage 2) + cropped
                              (Stage 3) frame, reusing the same generator the
                              mask editor draws on (anchor coords == these pixels).
  • ``outlines/{safe}.csv`` — a copy of the resampled outline CSV (Stage 4).
  • ``manifest.csv``        — one row per exported specimen: id, label, series,
                              source filename, image + outline paths, outline
                              point count, and the orient/crop/mask provenance.

A canonical missing any of orient / crop / mask (outline) is reported in
``skipped`` with the specific artifact(s) it lacks — never silently dropped, so
"N of M ready" on the gallery matches ``exportedCount`` exactly. ``out/`` is
gitignored under ``backend/state/``.
"""

from __future__ import annotations

import os
import shutil

import pandas as pd
from fastapi import APIRouter

from .. import models, processing
from ..state import BACKEND_ROOT, derived_dir, load_state
from . import deps

router = APIRouter(prefix="/api", tags=["export"])

# Stable manifest column order (a superset of the roadmap's required columns:
# specimenId, label, series, source filename, outline path, point count, and the
# orient/crop/mask sources — plus specimenIdSafe as a join key and imagePath for
# the exported standardized frame). Phase 8 reads outlines via ``outlinePath``.
MANIFEST_COLUMNS = [
    "specimenId",
    "specimenIdSafe",
    "label",
    "series",
    "filename",
    "imagePath",
    "outlinePath",
    "pointCount",
    "orientSource",
    "cropSource",
    "maskSource",
]


def _crop_bbox(box: dict) -> list[int]:
    """A stored crop box → the ``[x, y, w, h]`` int bbox the image generator wants."""
    return [
        int(box["x1"]),
        int(box["y1"]),
        int(box["x2"] - box["x1"]),
        int(box["y2"] - box["y1"]),
    ]


@router.post("/{series}/export", response_model=models.ExportResult)
def export(series: str) -> models.ExportResult:
    ds = deps.get_series(series)
    idx = deps.record_index(ds)
    masks = (load_state(series, "mask", {}) or {}).get("masks", {})
    orient = (load_state(series, "orient", {}) or {}).get("orientations", {})
    crops = (load_state(series, "crop", {}) or {}).get("crops", {})

    out_dir = derived_dir(series, "out")
    out_images = out_dir / "images"
    out_outlines = out_dir / "outlines"
    out_images.mkdir(parents=True, exist_ok=True)
    out_outlines.mkdir(parents=True, exist_ok=True)

    rows: list[dict] = []
    skipped: list[models.ExportSkip] = []
    for rk in deps.canonical_record_keys(series):
        rec = idx.get(rk)
        if rec is None:
            skipped.append(models.ExportSkip(record_key=rk, reason="unknown record"))
            continue

        entry = masks.get(rk)
        o = orient.get(rk)
        box = crops.get(rk)
        rel = entry.get("outlineRelPath") if entry else None
        outline_src = BACKEND_ROOT / rel if rel else None
        has_outline = outline_src is not None and outline_src.exists()

        # A specimen is exportable only with all three upstream artifacts present;
        # flag exactly what is missing so the gallery can surface it.
        missing = []
        if o is None:
            missing.append("orient (Stage 2)")
        if box is None:
            missing.append("crop (Stage 3)")
        if not has_outline:
            missing.append("mask outline (Stage 4)")
        if missing:
            skipped.append(
                models.ExportSkip(record_key=rk, reason="missing " + ", ".join(missing))
            )
            continue

        # Standardized frame — same rotate→crop the editor/thumbnail use.
        angle = float(o["angleDeg"])
        img = processing.standardized_crop_image(rec, angle, _crop_bbox(box))
        image_dest = out_images / f"{rec.specimen_id_safe}.png"
        img.save(image_dest, format="PNG")

        outline_dest = out_outlines / f"{rec.specimen_id_safe}.csv"
        shutil.copyfile(outline_src, outline_dest)

        rows.append(
            {
                "specimenId": rec.specimen_id,
                "specimenIdSafe": rec.specimen_id_safe,
                "label": rec.label,
                "series": series,
                "filename": rec.filename,
                "imagePath": os.path.relpath(image_dest, BACKEND_ROOT),
                "outlinePath": os.path.relpath(outline_dest, BACKEND_ROOT),
                "pointCount": entry.get("outlinePointCount", models.DEFAULT_OUTLINE_POINTS),
                "orientSource": o.get("source"),
                "cropSource": box.get("source"),
                "maskSource": entry.get("source"),
            }
        )

    manifest_path = out_dir / "manifest.csv"
    # Fixed column order even when no specimen is ready (empty but valid manifest).
    pd.DataFrame(rows, columns=MANIFEST_COLUMNS).to_csv(manifest_path, index=False)
    return models.ExportResult(
        manifest_path=os.path.relpath(manifest_path, BACKEND_ROOT),
        exported_count=len(rows),
        skipped=skipped,
    )
