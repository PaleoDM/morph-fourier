"""Per-series JSON state persistence and series discovery.

The persistence layer is plain JSON files on disk — no database (ROADMAP §2).
Every state file lives at ``backend/state/{seriesKey}/{name}.json``; derived
artifacts live in gitignored subdirectories of the same folder
(``outlines/``, ``efa/``, ``pca/``, ``out/``).

**Casing invariant:** everything written here is expected to already be in
camelCase (the Pydantic models serialize ``by_alias=True``). This module does
not transform keys — it just reads and writes JSON verbatim — so what a model
dumps is exactly what lands on disk and round-trips back deep-equal.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Optional

from .filenames import DiscoveredSeries, safe_key
from .filenames import discover_series as _discover_series

# BACKEND_ROOT points at apps/morph-fourier/backend/
BACKEND_ROOT = Path(__file__).resolve().parent.parent.parent
APP_ROOT = BACKEND_ROOT.parent  # apps/morph-fourier/
STATE_ROOT = BACKEND_ROOT / "state"

# Derived-artifact subdirectories inside each series dir (gitignored).
DERIVED_SUBDIRS = ("outlines", "efa", "pca", "out")


def photos_root() -> Path:
    """The configured photos root (``MORPH_FOURIER_PHOTOS_ROOT``, default ``photos/``)."""
    return Path(os.environ.get("MORPH_FOURIER_PHOTOS_ROOT", APP_ROOT / "photos"))


def state_root() -> Path:
    """Root of the on-disk state tree (``backend/state/``)."""
    return STATE_ROOT


def series_dir(key: str) -> Path:
    """Directory holding one series' state files: ``backend/state/{key}/``."""
    return STATE_ROOT / key


def state_path(series: str, name: str) -> Path:
    """Path to a single state file, e.g. ``series_dir(series)/curation.json``.

    ``name`` may be given with or without the ``.json`` suffix.
    """
    filename = name if name.endswith(".json") else f"{name}.json"
    return series_dir(series) / filename


def load_state(series: str, name: str, default: Any = None) -> Any:
    """Read and JSON-parse a state file. Returns ``default`` if it doesn't exist."""
    path = state_path(series, name)
    if not path.exists():
        return default
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def save_state(series: str, name: str, data: Any) -> Path:
    """Serialize ``data`` to ``backend/state/{series}/{name}.json`` (creating dirs).

    ``data`` may be a plain dict/list or a Pydantic model. Models are dumped with
    ``by_alias=True`` (JSON mode) so on-disk keys are camelCase, matching the
    TypeScript interfaces exactly. Returns the path written.
    """
    path = state_path(series, name)
    path.parent.mkdir(parents=True, exist_ok=True)

    # Duck-type Pydantic models without importing pydantic here.
    if hasattr(data, "model_dump"):
        payload = data.model_dump(by_alias=True, mode="json")
    else:
        payload = data

    with path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False, sort_keys=False)
        f.write("\n")
    return path


def derived_dir(series: str, kind: str) -> Path:
    """A derived-artifact subdirectory (e.g. ``outlines``) inside a series dir."""
    if kind not in DERIVED_SUBDIRS:
        raise ValueError(f"unknown derived subdir {kind!r}; expected one of {DERIVED_SUBDIRS}")
    return series_dir(series) / kind


def discover_series(root: Optional[Path] = None) -> list[DiscoveredSeries]:
    """Discover series under the configured photos root (or an explicit ``root``).

    Thin wrapper over :func:`filenames.discover_series` that defaults to
    :func:`photos_root`. Sanitizes each folder name to a safe key, raises
    ``SeriesKeyCollisionError`` if two folders collide, and returns each series'
    parsed records plus its unparseable files (never dropped).
    """
    return _discover_series(root if root is not None else photos_root())


__all__ = [
    "BACKEND_ROOT",
    "APP_ROOT",
    "STATE_ROOT",
    "DERIVED_SUBDIRS",
    "photos_root",
    "state_root",
    "series_dir",
    "state_path",
    "load_state",
    "save_state",
    "derived_dir",
    "discover_series",
    "safe_key",
]
