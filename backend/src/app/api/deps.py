"""Shared helpers for the Phase 1B route modules.

Series/record lookups, the canonical-set derivation the status envelopes need,
timestamp helper, a lazily-loaded SAM predictor (503 when weights are absent),
and the per-stage :class:`StageStatus` computation the nav badges consume.

Nothing here defines a new persisted type — the response envelopes and state
models all live in ``app.models`` (mirrors of ``domain.ts``).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from fastapi import HTTPException

from .. import models, processing
from ..filenames import DiscoveredSeries
from ..filenames import PhotoRecord as ParsedRecord
from ..state import discover_series, load_state


def now_iso() -> str:
    """Current UTC time as an ISO-8601 ``...Z`` string (matches the domain contract)."""
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


# ---------- Series & record lookup ----------


def get_series(series_key: str) -> DiscoveredSeries:
    """Discovered series for ``series_key`` or a 404."""
    for ds in discover_series():
        if ds.key == series_key:
            return ds
    raise HTTPException(status_code=404, detail=f"Unknown series {series_key!r}.")


def record_index(ds: DiscoveredSeries) -> dict[str, ParsedRecord]:
    """Map ``recordKey → parsed PhotoRecord`` for one series."""
    return {r.record_key: r for r in ds.records}


def get_record(series_key: str, record_key: str) -> ParsedRecord:
    """Parsed source record for one ``recordKey`` or a 404."""
    ds = get_series(series_key)
    rec = record_index(ds).get(record_key)
    if rec is None:
        raise HTTPException(
            status_code=404, detail=f"Unknown record {record_key!r} in series {series_key!r}."
        )
    return rec


def to_photo_model(rec: ParsedRecord) -> models.PhotoRecord:
    """Convert an internal parsed record to the wire ``PhotoRecord`` model."""
    return models.PhotoRecord(
        record_key=rec.record_key,
        series_key=rec.series_key,
        filename=rec.filename,
        specimen_id=rec.specimen_id,
        specimen_id_safe=rec.specimen_id_safe,
        specimen_key=rec.specimen_key,
        label=rec.label,
        photo_index=rec.photo_index,
    )


# ---------- Canonical set (the pipeline working set) ----------


def canonical_record_keys(series_key: str) -> list[str]:
    """Record keys the user marked canonical (accepted + isCanonical) in curation.json."""
    cur = load_state(series_key, "curation", {}) or {}
    photos = cur.get("photos", {})
    return [
        rk
        for rk, dec in photos.items()
        if dec.get("isCanonical") and dec.get("status") == "accepted"
    ]


# ---------- SAM predictor (lazy singleton) ----------

_sam_predictor = None


def get_sam_predictor():
    """Load SAM once and cache it. Raises 503 if the weights file is absent.

    Segmentation is the only endpoint family that needs SAM; gating here keeps
    the rest of the API (and its tests) runnable without the ~375 MB weights.
    """
    global _sam_predictor
    if not processing.SAM_WEIGHTS_PATH.exists():
        raise HTTPException(
            status_code=503,
            detail=(
                "SAM weights not found at "
                f"{processing.SAM_WEIGHTS_PATH.name}. Run setup.command to download them."
            ),
        )
    if _sam_predictor is None:
        _sam_predictor, _ = processing.load_sam_predictor()
    return _sam_predictor


# ---------- Per-stage status (nav badges) ----------


def _outline_exists(series_key: str, mask_entry: dict) -> bool:
    """Whether a mask entry's resampled outline CSV is present on disk."""
    from ..state import BACKEND_ROOT

    rel = mask_entry.get("outlineRelPath")
    return bool(rel) and (BACKEND_ROOT / rel).exists()


def stage_status(series_key: str, stage_id: str) -> models.StageStatus:
    """Compute the :class:`StageStatus` envelope for one stage.

    ``totalCanonicals`` is the pipeline working set (canonical photos). ``readyCount``
    is how many of those have completed this stage. ``locked`` applies to stages 2–4;
    ``lastComputedAt`` to the analysis stages (6–8).
    """
    canon = canonical_record_keys(series_key)
    canon_set = set(canon)
    total = len(canon)
    ready = 0
    locked = False
    last_computed: Optional[str] = None

    if stage_id == "curation":
        # A canonical is, by definition, curated. Badge tracks canonicals chosen.
        ready = total
    elif stage_id == "orient":
        st = load_state(series_key, "orient", {}) or {}
        locked = st.get("lockedAt") is not None
        ready = sum(1 for rk in st.get("orientations", {}) if rk in canon_set)
    elif stage_id == "crop":
        st = load_state(series_key, "crop", {}) or {}
        locked = st.get("lockedAt") is not None
        ready = sum(1 for rk in st.get("crops", {}) if rk in canon_set)
    elif stage_id == "mask":
        st = load_state(series_key, "mask", {}) or {}
        locked = st.get("lockedAt") is not None
        masks = st.get("masks", {})
        ready = sum(
            1 for rk, m in masks.items() if rk in canon_set and _outline_exists(series_key, m)
        )
    elif stage_id == "gallery":
        st = load_state(series_key, "mask", {}) or {}
        masks = st.get("masks", {})
        ready = sum(
            1 for rk, m in masks.items() if rk in canon_set and _outline_exists(series_key, m)
        )
    elif stage_id == "efa":
        st = load_state(series_key, "efa_settings", {}) or {}
        last_computed = st.get("lastComputedAt")
        ready = min(int(st.get("nSpecimensComputed", 0)), total)
    elif stage_id == "pca":
        st = load_state(series_key, "pca_settings", {}) or {}
        last_computed = st.get("lastComputedAt")
        ready = total if last_computed else 0
    elif stage_id == "morphospace":
        pca = load_state(series_key, "pca_settings", {}) or {}
        last_computed = pca.get("lastComputedAt")
        tax = load_state(series_key, "taxonomy", {}) or {}
        assignments = tax.get("assignments", {})
        # Map canonicals to their specimenIdSafe (assignments are keyed by that).
        ds = None
        try:
            ds = get_series(series_key)
        except HTTPException:
            ds = None
        if ds is not None:
            idx = record_index(ds)
            safe_ids = {idx[rk].specimen_id_safe for rk in canon if rk in idx}
            ready = sum(1 for sid in safe_ids if sid in assignments)
    else:
        raise HTTPException(status_code=404, detail=f"Unknown stage {stage_id!r}.")

    return models.StageStatus(
        series_key=series_key,
        locked=locked,
        last_computed_at=last_computed,
        ready_count=ready,
        total_canonicals=total,
    )


STAGE_IDS = (
    "curation",
    "orient",
    "crop",
    "mask",
    "gallery",
    "efa",
    "pca",
    "morphospace",
)


def all_stage_statuses(series_key: str) -> dict[str, models.StageStatus]:
    """All eight stage statuses for one series (backs ``useActiveSeriesStatus``)."""
    return {sid: stage_status(series_key, sid) for sid in STAGE_IDS}
