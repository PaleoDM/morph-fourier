"""Series discovery + aggregate status.

``GET /api/series`` is the app's entry point (drives the SeriesSelector and the
empty-state screen). ``GET /api/{series}/status`` returns all eight stage
statuses in one call so the nav rail can render its badges without eight
round-trips (backs the frontend's ``useActiveSeriesStatus`` hook).
"""

from __future__ import annotations

from fastapi import APIRouter

from .. import models
from ..state import discover_series
from . import deps

router = APIRouter(prefix="/api", tags=["series"])


@router.get("/series", response_model=list[models.Series])
def list_series() -> list[models.Series]:
    """Every series discovered under ``MORPH_FOURIER_PHOTOS_ROOT``."""
    return [
        models.Series(key=ds.key, display_name=ds.display_name, photo_count=ds.photo_count)
        for ds in discover_series()
    ]


@router.get("/{series}/status", response_model=dict[str, models.StageStatus])
def series_status(series: str) -> dict[str, models.StageStatus]:
    """All eight stage statuses for one series, keyed by stage id."""
    deps.get_series(series)  # 404 if unknown
    return deps.all_stage_statuses(series)
