"""Stage 1 — Curation: accept/reject decisions + canonical marking.

State lives in ``curation.json`` as ``{ recordKey → PhotoDecision }``. The
canonical rule (ROADMAP §6) is enforced here: exactly one canonical per specimen,
and only accepted photos can be canonical.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .. import models
from ..state import load_state, save_state
from . import deps

router = APIRouter(prefix="/api", tags=["curation"])


def _load(series: str) -> models.CurationState:
    raw = load_state(series, "curation")
    if raw is None:
        return models.CurationState(updated_at=deps.now_iso())
    return models.CurationState.model_validate(raw)


@router.get("/{series}/curation", response_model=models.CurationState)
def get_curation(series: str) -> models.CurationState:
    deps.get_series(series)
    return _load(series)


@router.get("/{series}/records", response_model=models.SeriesRecords)
def get_records(series: str) -> models.SeriesRecords:
    """Every parsed photo in the series (with ``specimenKey`` for grouping) plus the
    filenames the parser could not read. The curation grid groups ``records`` by
    ``specimenKey``; ``unparseable`` feeds the "couldn't parse these" panel.
    """
    ds = deps.get_series(series)
    return models.SeriesRecords(
        records=[deps.to_photo_model(r) for r in ds.records],
        unparseable=[u.filename for u in ds.unparseable],
    )


@router.put("/{series}/curation/{record_key:path}", response_model=models.CurationState)
def set_decision(
    series: str, record_key: str, decision: models.PhotoDecision
) -> models.CurationState:
    """Upsert one photo's decision, enforcing the canonical rule."""
    ds = deps.get_series(series)
    idx = deps.record_index(ds)
    if record_key not in idx:
        raise HTTPException(status_code=404, detail=f"Unknown record {record_key!r}.")

    if decision.is_canonical and decision.status != "accepted":
        raise HTTPException(
            status_code=400, detail="Only an accepted photo can be marked canonical."
        )

    st = _load(series)

    if decision.is_canonical:
        # Clear any prior canonical in the same specimen group (one per specimen).
        specimen_key = idx[record_key].specimen_key
        for rk, existing in st.photos.items():
            if rk == record_key:
                continue
            other = idx.get(rk)
            if other is not None and other.specimen_key == specimen_key and existing.is_canonical:
                existing.is_canonical = False

    st.photos[record_key] = decision
    st.updated_at = deps.now_iso()
    save_state(series, "curation", st)
    return st
