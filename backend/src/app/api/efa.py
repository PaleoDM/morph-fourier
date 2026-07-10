"""Stages 6 — EFA: harmonic calibration, coefficient compute, per-specimen inspector.

All three compute endpoints wire the ported ``analysis`` math over the outline CSVs
written in Stage 4. ``calibrate`` pools cumulative-power curves; ``compute`` writes
``efa/coefficients.csv`` and updates ``efa_settings.json``; ``reconstruct`` powers
the Stage-6 original-vs-reconstruction inspector.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import numpy as np
from fastapi import APIRouter, HTTPException

from .. import analysis, models
from ..state import BACKEND_ROOT, derived_dir, load_state, save_state
from . import deps


router = APIRouter(prefix="/api", tags=["efa"])


def _load_settings(series: str) -> models.EfaSettings:
    raw = load_state(series, "efa_settings")
    if raw is None:
        return models.EfaSettings()
    return models.EfaSettings.model_validate(raw)


def _canonical_outlines(series: str) -> dict[str, np.ndarray]:
    """``specimenIdSafe → outline array`` for every canonical with a saved outline CSV."""
    ds = deps.get_series(series)
    idx = deps.record_index(ds)
    mask_state = load_state(series, "mask", {}) or {}
    masks = mask_state.get("masks", {})

    outlines: dict[str, np.ndarray] = {}
    for rk in deps.canonical_record_keys(series):
        rec = idx.get(rk)
        entry = masks.get(rk)
        if rec is None or not entry:
            continue
        rel = entry.get("outlineRelPath")
        if not rel:
            continue
        path = BACKEND_ROOT / rel
        if not path.exists():
            continue
        outlines[rec.specimen_id_safe] = analysis.load_outline_csv(path)
    return outlines


def _outline_path_for_record(series: str, record_key: str) -> Path | None:
    """Resolve one record's saved outline CSV path (or ``None`` if unmasked)."""
    mask_state = load_state(series, "mask", {}) or {}
    entry = mask_state.get("masks", {}).get(record_key)
    if not entry:
        return None
    rel = entry.get("outlineRelPath")
    if not rel:
        return None
    path = BACKEND_ROOT / rel
    return path if path.exists() else None


@lru_cache(maxsize=256)
def _reconstruct_cached(
    path_str: str, mtime_ns: int, harmonics: int, normalize: bool, anchor: str
) -> tuple[tuple[tuple[float, float], ...], tuple[float, ...]]:
    """Reconstruct + power spectrum for one (outline, harmonics, normalize, anchor).

    Keyed by the outline path + its mtime so a re-mask (which rewrites the CSV)
    misses the cache and recomputes, but repeated inspector views of the same
    settings are served from memory — the per-inspector-view latency the roadmap
    flagged. Results are plain tuples so they hash/persist in the LRU cleanly.
    """
    outline = analysis.load_outline_csv(Path(path_str))
    coeffs = (
        analysis.compute_efa_oriented(outline, harmonics=harmonics, anchor=anchor)
        if normalize
        else analysis.compute_efa(outline, harmonics=harmonics, normalize=False)
    )
    recon = analysis.reconstruct_outline(coeffs, n_points=models.DEFAULT_OUTLINE_POINTS // 2)
    power = analysis.harmonic_power(coeffs)
    return (
        tuple((float(x), float(y)) for x, y in recon),
        tuple(float(p) for p in power),
    )


@router.get("/{series}/efa", response_model=models.EfaSettings)
def get_efa(series: str) -> models.EfaSettings:
    deps.get_series(series)
    return _load_settings(series)


@router.post("/{series}/efa/calibrate", response_model=models.CalibrationResult)
def calibrate(series: str) -> models.CalibrationResult:
    """Pool cumulative-power curves across canonicals; recommend harmonic counts."""
    deps.get_series(series)
    outlines = list(_canonical_outlines(series).values())
    result = analysis.calibrate_harmonics(outlines, max_harmonics=models.MAX_HARMONICS)
    recommended = [
        models.RecommendedHarmonic(threshold=float(t), harmonics=int(h))
        for t, h in sorted(result["recommended"].items())
    ]
    return models.CalibrationResult(
        mean_curve=[float(v) for v in result["mean_curve"]],
        recommended=recommended,
        n_specimens=int(result["n_specimens"]),
    )


@router.post("/{series}/efa/compute", response_model=models.EfaSettings)
def compute(series: str, req: models.EfaComputeRequest) -> models.EfaSettings:
    """Compute EFA coefficients for all canonicals; write ``efa/coefficients.csv``."""
    deps.get_series(series)
    settings = _load_settings(series)
    harmonics = req.harmonics if req.harmonics is not None else settings.harmonics
    normalize = req.normalize if req.normalize is not None else settings.normalize
    anchor = req.anchor if req.anchor is not None else settings.anchor

    outlines = _canonical_outlines(series)
    if not outlines:
        raise HTTPException(
            status_code=409, detail="No outlines available — complete Stage 4 (mask) first."
        )

    # "Normalize" here means orientation-preserving normalization (size + start point,
    # keeping the user's orientation) — not full Kuhl & Giardina, which would discard
    # the Orient step and split the set into spurious flipped clusters.
    coeffs = {
        safe: (
            analysis.compute_efa_oriented(outline, harmonics=harmonics, anchor=anchor)
            if normalize
            else analysis.compute_efa(outline, harmonics=harmonics, normalize=False)
        )
        for safe, outline in outlines.items()
    }
    df = analysis.coefficients_to_dataframe(coeffs, harmonics)
    efa_dir = derived_dir(series, "efa")
    efa_dir.mkdir(parents=True, exist_ok=True)
    df.to_csv(efa_dir / "coefficients.csv", index=False)

    settings.harmonics = harmonics
    settings.normalize = normalize
    settings.anchor = anchor
    settings.n_specimens_computed = len(coeffs)
    settings.last_computed_at = deps.now_iso()
    save_state(series, "efa_settings", settings)
    return settings


@router.post("/{series}/efa/reconstruct", response_model=models.ReconstructResult)
def reconstruct(series: str, req: models.EfaReconstructRequest) -> models.ReconstructResult:
    """Stage-6 inspector: reconstruct one specimen's outline + its power spectrum."""
    rec = deps.get_record(series, req.record_key)
    settings = _load_settings(series)
    harmonics = req.harmonics if req.harmonics is not None else settings.harmonics

    path = _outline_path_for_record(series, req.record_key)
    if path is None:
        raise HTTPException(
            status_code=409, detail=f"No outline for {rec.specimen_id_safe}; mask it first."
        )

    recon, power = _reconstruct_cached(
        str(path), path.stat().st_mtime_ns, int(harmonics), bool(req.normalize), req.anchor
    )
    return models.ReconstructResult(
        outline=[models.Point(x=x, y=y) for x, y in recon],
        power_spectrum=list(power),
    )
