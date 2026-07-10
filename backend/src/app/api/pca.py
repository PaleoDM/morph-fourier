"""Stage 7 — PCA: fit on the EFA coefficient matrix + shape-along-PC back-projection.

``POST /pca/run`` fits PCA over ``efa/coefficients.csv``, writes the three artifact
CSVs (``scores``, ``loadings`` with a ``mean`` column, ``eigenvalues``), and updates
``pca_settings.json``. ``GET /pca`` returns the current :class:`PcaResult` (recomputed
deterministically from the coefficients). ``POST /pca/reconstruct`` back-projects a
point in PC space to an outline (Stage-9 morphospace shape strips).
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException

from .. import analysis, models
from ..state import derived_dir, load_state, save_state
from . import deps

router = APIRouter(prefix="/api", tags=["pca"])


def _load_settings(series: str) -> models.PcaSettings:
    raw = load_state(series, "pca_settings")
    if raw is None:
        return models.PcaSettings()
    return models.PcaSettings.model_validate(raw)


def _coefficients_df(series: str) -> pd.DataFrame | None:
    path = derived_dir(series, "efa") / "coefficients.csv"
    if not path.exists():
        return None
    # Force the id column to str: purely-numeric catalog numbers (e.g. "49775")
    # would otherwise be inferred as int and break PcaResult.specimenIds (list[str]).
    return pd.read_csv(path, dtype={"specimen_id_safe": str})


MIN_FIT_SPECIMENS = 2  # below this there is no variance to decompose; refuse to fit


def _compute(series: str, excluded: set[str] | None = None) -> tuple[dict, int]:
    """Recompute the PCA result from the persisted coefficients, optionally dropping
    ``excluded`` specimens from the fit so a dominant group can be set aside and the
    retained specimens define their own axes. Raises 409 if unavailable or too few
    specimens remain."""
    df = _coefficients_df(series)
    if df is None:
        raise HTTPException(status_code=409, detail="Run Stage 6 (EFA compute) first.")
    if excluded:
        df = df[~df["specimen_id_safe"].isin(excluded)]
    if len(df) < MIN_FIT_SPECIMENS:
        raise HTTPException(
            status_code=409,
            detail=(
                f"At least {MIN_FIT_SPECIMENS} specimens must remain in the PCA fit; "
                f"{len(df)} left after exclusions."
            ),
        )
    efa = load_state(series, "efa_settings", {}) or {}
    harmonics = int(efa.get("harmonics", models.DEFAULT_HARMONICS))
    try:
        return analysis.run_pca_on_coefficients(df, harmonics), harmonics
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))


def _to_result(pca: dict) -> models.PcaResult:
    return models.PcaResult(
        specimen_ids=list(pca["specimen_ids"]),
        scores=[[float(v) for v in row] for row in np.asarray(pca["scores"])],
        var_ratio=[float(v) for v in pca["explained_variance_ratio"]],
        cum_var_ratio=[float(v) for v in pca["cumulative_variance_ratio"]],
        loadings=[[float(v) for v in row] for row in np.asarray(pca["loadings"])],
        mean=[float(v) for v in pca["mean"]],
        feature_names=list(pca["feature_names"]),
        n_components=int(pca["n_components"]),
    )


@router.get("/{series}/pca", response_model=models.PcaResult)
def get_pca(series: str) -> models.PcaResult:
    deps.get_series(series)
    settings = _load_settings(series)
    if settings.last_computed_at is None:
        raise HTTPException(status_code=404, detail="PCA has not been run for this series.")
    pca, _ = _compute(series, set(settings.excluded_specimens))
    return _to_result(pca)


@router.get("/{series}/pca/settings", response_model=models.PcaSettings)
def get_pca_settings(series: str) -> models.PcaSettings:
    """Persisted PCA settings — carries ``harmonicsUsed`` (drift banner) and the
    retained-component count, without recomputing the fit. Defaults if never run."""
    deps.get_series(series)
    return _load_settings(series)


@router.post("/{series}/pca/run", response_model=models.PcaResult)
def run_pca(series: str, req: models.PcaRunRequest) -> models.PcaResult:
    """Fit PCA, write scores/loadings/eigenvalues CSVs, update pca_settings.

    ``excludedSpecimens`` (when provided) sets which specimens are dropped from the
    fit before recomputing; pass ``[]`` to clear the exclusion and refit on all.
    """
    deps.get_series(series)
    settings = _load_settings(series)
    if req.excluded_specimens is not None:
        # Dedupe, preserve order; this becomes the new persisted exclusion set.
        settings.excluded_specimens = list(dict.fromkeys(req.excluded_specimens))
    pca, harmonics = _compute(series, set(settings.excluded_specimens))

    pca_dir = derived_dir(series, "pca")
    pca_dir.mkdir(parents=True, exist_ok=True)
    analysis.pca_scores_dataframe(pca).to_csv(pca_dir / "scores.csv", index=False)
    analysis.pca_loadings_dataframe(pca).to_csv(pca_dir / "loadings.csv", index=False)
    analysis.pca_eigenvalues_dataframe(pca).to_csv(pca_dir / "eigenvalues.csv", index=False)

    # (settings already loaded above, carrying the updated exclusion set)
    settings.n_components_total = int(pca["n_components"])
    settings.harmonics_used = harmonics
    settings.variance_target = req.variance_target or settings.variance_target
    if req.n_components_retained is not None:
        settings.n_components_retained = req.n_components_retained
    else:
        # Auto: smallest PC count reaching the variance target.
        cum = np.asarray(pca["cumulative_variance_ratio"])
        meets = np.where(cum >= settings.variance_target)[0]
        settings.n_components_retained = int(meets[0] + 1) if len(meets) else int(pca["n_components"])
    settings.last_computed_at = deps.now_iso()
    save_state(series, "pca_settings", settings)
    return _to_result(pca)


@router.post("/{series}/pca/reconstruct", response_model=models.ReconstructResult)
def reconstruct(series: str, req: models.PcaReconstructRequest) -> models.ReconstructResult:
    """Back-project a point in PC space (``{pcIndex: score}``) to a closed outline."""
    deps.get_series(series)
    settings = _load_settings(series)
    pca, harmonics = _compute(series, set(settings.excluded_specimens))
    pc_values = {int(k): float(v) for k, v in req.pc_values.items()}
    outline = analysis.reconstruct_from_pca(pca, pc_values, harmonics)
    return models.ReconstructResult(
        outline=[models.Point(x=float(x), y=float(y)) for x, y in outline],
        power_spectrum=None,
    )
