"""FastAPI route modules for Morph-Fourier — one APIRouter per resource.

Registered in ``app.main``. Every router lives under the ``/api`` prefix; each
stage exposes a state GET and its mutations. Stage status is served only in
aggregate by ``GET /api/{series}/status`` (``series.py``) — the client reads all
eight stages in one call, so the per-stage ``/status`` routes were removed.
"""

from __future__ import annotations

from . import (
    automate,
    crop,
    curation,
    efa,
    export,
    mask,
    orient,
    pca,
    prime,
    review,
    series,
    taxonomy,
)

# Ordered so more specific literal paths are registered before the catch-all
# ``{record_key:path}`` routes within each stage — FastAPI matches in order.
ROUTERS = [
    series.router,
    curation.router,
    orient.router,
    crop.router,
    mask.router,
    efa.router,
    pca.router,
    taxonomy.router,
    export.router,
    automate.router,
    prime.router,
    review.router,
]

__all__ = ["ROUTERS"]
