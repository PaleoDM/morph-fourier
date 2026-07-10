"""Stage 8 — Taxonomy: user-defined metadata columns + per-specimen assignments.

State is ``taxonomy.json``. Assignments are keyed by ``specimenIdSafe`` and column
names are user data (e.g. ``Mass_kg``) — both are passed through untouched (never
camelCased); only the schema field names are camelCase. This stage's status is
surfaced under the ``morphospace`` stage id (Stage 8 in the nav) via the aggregate
``GET /api/{series}/status``.
"""

from __future__ import annotations

from fastapi import APIRouter

from .. import models
from ..state import load_state, save_state
from . import deps

router = APIRouter(prefix="/api", tags=["taxonomy"])


def _load(series: str) -> models.TaxonomyState:
    raw = load_state(series, "taxonomy")
    if raw is None:
        return models.TaxonomyState(updated_at=deps.now_iso())
    return models.TaxonomyState.model_validate(raw)


@router.get("/{series}/taxonomy", response_model=models.TaxonomyState)
def get_taxonomy(series: str) -> models.TaxonomyState:
    deps.get_series(series)
    return _load(series)


@router.put("/{series}/taxonomy", response_model=models.TaxonomyState)
def put_taxonomy(series: str, state: models.TaxonomyState) -> models.TaxonomyState:
    """Replace the taxonomy table (columns + assignments)."""
    deps.get_series(series)
    state.updated_at = deps.now_iso()
    save_state(series, "taxonomy", state)
    return state
