"""FastAPI entrypoint for the Morph-Fourier backend.

Registers the Phase 1B route surface (one router per resource, all under
``/api/*``), serves raw source photos from ``MORPH_FOURIER_PHOTOS_ROOT`` at
``/photos/{series}/{filename}``, and — in production — serves the built React
bundle at ``/`` with an SPA fallback.

Route registration order matters: the API routers and the photo handler are
mounted before the catch-all SPA fallback so real endpoints always win.
"""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from .api import ROUTERS
from .api.deps import get_series
from .state import photos_root

# --- Paths ---
# BACKEND_ROOT points at apps/morph-fourier/backend/
BACKEND_ROOT = Path(__file__).resolve().parent.parent.parent
APP_ROOT = BACKEND_ROOT.parent  # apps/morph-fourier/
FRONTEND_DIST = APP_ROOT / "frontend" / "dist"

# --- App ---
app = FastAPI(
    title="Morph-Fourier API",
    version=__version__,
    description="Backend for the generalized shape analysis pipeline.",
)

# In dev mode Vite proxies /api/* here so CORS is not strictly required,
# but keeping this open makes local iteration painless.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:8000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health() -> dict:
    """Basic scaffold health check. Confirms the API is up and paths resolve."""
    root = photos_root()
    return {
        "status": "ok",
        "version": __version__,
        "photos_root": str(root),
        "photos_root_exists": root.exists(),
        "frontend_bundle_exists": FRONTEND_DIST.exists(),
    }


# --- API routers ---
for _router in ROUTERS:
    app.include_router(_router)


# --- Raw photo serving ---
@app.get("/photos/{series}/{filename}", tags=["photos"])
def serve_photo(series: str, filename: str) -> FileResponse:
    """Serve a raw source image for one series. 404 on unknown series or missing file.

    ``filename`` is a bare name (no path segments); anything with a separator or a
    parent reference is rejected to prevent directory traversal outside the series
    folder.
    """
    if "/" in filename or "\\" in filename or ".." in filename or filename.startswith("."):
        raise HTTPException(status_code=404, detail="Not found.")
    ds = get_series(series)  # 404 if the series key is unknown
    folder = (photos_root() / ds.display_name).resolve()
    path = (folder / filename).resolve()
    if os.path.commonpath([str(folder), str(path)]) != str(folder) or not path.is_file():
        raise HTTPException(status_code=404, detail="Photo not found.")
    return FileResponse(path)


# --- Static asset serving (production only) ---
# The built React bundle is served by this same process. Registered LAST so the
# catch-all SPA fallback never shadows /api/* or /photos/*. In dev (no dist),
# nothing is mounted and Vite serves the frontend instead.
if FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

    @app.get("/{full_path:path}")
    async def spa_fallback(full_path: str) -> FileResponse:
        """SPA fallback — every non-API route returns index.html so the React
        router can handle client-side navigation.
        """
        return FileResponse(FRONTEND_DIST / "index.html")
