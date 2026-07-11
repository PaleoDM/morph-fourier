"""Create a series and upload images into it, without touching the filesystem by hand.

Two endpoints back the in-app upload flow:

  ``POST /api/series``            — create a new series folder + write initial images.
  ``POST /api/{series}/upload``   — add more images to an existing series.

Both write the raw image files into ``<photos_root>/<display_name>/`` and return an
:class:`~app.models.UploadResult` summarizing what landed. Files that aren't a
``.jpg/.jpeg/.png`` are skipped; files that are written but don't match the naming
convention are reported as ``unrecognized`` (they'll show under the curation stage's
unparseable list rather than becoming specimens).
"""

from __future__ import annotations

import shutil
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from .. import models
from ..filenames import IMAGE_EXTENSIONS, safe_key
from ..state import discover_series, photos_root
from . import deps

router = APIRouter(prefix="/api", tags=["upload"])

# Sanity cap so a runaway multipart request can't fill the disk in one call.
MAX_FILES = 5000


def _write_images(folder: Path, files: list[UploadFile]) -> tuple[int, list[str]]:
    """Write accepted images into ``folder``; return (written_count, skipped_names)."""
    if len(files) > MAX_FILES:
        raise HTTPException(
            status_code=413, detail=f"Too many files in one upload (max {MAX_FILES})."
        )
    folder.mkdir(parents=True, exist_ok=True)
    written = 0
    skipped: list[str] = []
    for f in files:
        # Strip any path components a client may have sent (traversal guard).
        name = Path(f.filename or "").name
        if not name or name.startswith(".") or Path(name).suffix.lower() not in IMAGE_EXTENSIONS:
            skipped.append(name or "(unnamed)")
            continue
        dest = folder / name
        with dest.open("wb") as out:
            shutil.copyfileobj(f.file, out)
        written += 1
    return written, skipped


def _result(series_key: str, uploaded: int, skipped: list[str]) -> models.UploadResult:
    """Re-discover the series post-write so counts reflect what's on disk."""
    ds = deps.get_series(series_key)
    return models.UploadResult(
        series=models.Series(
            key=ds.key, display_name=ds.display_name, photo_count=ds.photo_count
        ),
        uploaded=uploaded,
        skipped=skipped,
        unrecognized=len(ds.unparseable),
    )


@router.post("/series", response_model=models.UploadResult, status_code=201)
def create_series(
    name: str = Form(...),
    files: list[UploadFile] = File(default=[]),
) -> models.UploadResult:
    """Create a new series from a display name (+ optional initial images)."""
    display = name.strip()
    key = safe_key(display)
    if not key:
        raise HTTPException(
            status_code=422, detail="Series name must contain letters or numbers."
        )
    if any(ds.key == key for ds in discover_series()):
        raise HTTPException(
            status_code=409, detail=f"A series that maps to key {key!r} already exists."
        )
    uploaded, skipped = _write_images(photos_root() / display, files)
    return _result(key, uploaded, skipped)


@router.post("/{series}/upload", response_model=models.UploadResult)
def upload_to_series(
    series: str,
    files: list[UploadFile] = File(...),
) -> models.UploadResult:
    """Add images to an existing series."""
    ds = deps.get_series(series)  # 404 if unknown
    uploaded, skipped = _write_images(photos_root() / ds.display_name, files)
    return _result(series, uploaded, skipped)
