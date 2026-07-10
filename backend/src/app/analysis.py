"""EFA, harmonic-power calibration, and PCA helpers for Stages 6–7.

Pure math + small I/O helpers. No Streamlit imports. Keeping this module
small and side-effect-free so it's easy to test in isolation and reuse
from non-UI contexts later (e.g., headless re-export).
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterable

import numpy as np
import pandas as pd
import pyefd


# ---------- Outline I/O ----------


def load_outline_csv(path: Path) -> np.ndarray:
    """Load a Stage 4 outline CSV (columns x, y) as an (N, 2) float64 array."""
    df = pd.read_csv(path)
    if not {"x", "y"}.issubset(df.columns):
        raise ValueError(f"{path} missing x/y columns; got {list(df.columns)}")
    return df[["x", "y"]].to_numpy(dtype=np.float64)


# ---------- Core EFA ----------


def compute_efa(contour: np.ndarray, harmonics: int, normalize: bool = True) -> np.ndarray:
    """Compute elliptic Fourier coefficients for a single closed outline.

    Returns an array of shape (harmonics, 4) — each row is (a_n, b_n, c_n, d_n)
    for harmonic n (1..harmonics). When normalize=True, pyefd applies the
    Kuhl & Giardina (1982) normalization: starting point, rotation, and size
    are all aligned so coefficients are directly comparable across specimens.
    """
    if contour.ndim != 2 or contour.shape[1] != 2:
        raise ValueError(f"contour must be (N, 2); got shape {contour.shape}")
    if len(contour) < 4:
        raise ValueError(f"contour too short ({len(contour)} points) for EFA")
    if harmonics < 1:
        raise ValueError(f"harmonics must be >= 1; got {harmonics}")
    return pyefd.elliptic_fourier_descriptors(
        contour, order=int(harmonics), normalize=bool(normalize)
    )


# Anchor → (coordinate axis, extreme selector). The start point is the outline vertex
# that is most extreme in the chosen direction, in the user's oriented frame.
_ANCHOR_SELECTORS = {
    "top": (1, np.argmin),     # smallest y (top of an upright frame)
    "bottom": (1, np.argmax),
    "left": (0, np.argmin),
    "right": (0, np.argmax),
}


def _signed_area(contour: np.ndarray) -> float:
    x, y = contour[:, 0], contour[:, 1]
    return 0.5 * float(np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y))


def standardize_contour(contour: np.ndarray, anchor: str = "top") -> np.ndarray:
    """Fix the two arbitrary choices raw EFA is sensitive to, using the specimen's
    orientation: traversal direction and start point.

    Winding is forced counter-clockwise, then the contour is rolled to begin at its
    most-extreme vertex in the ``anchor`` direction (``top`` | ``bottom`` | ``left`` |
    ``right``). Because every specimen has already been oriented to a common "up",
    that landmark is the same anatomical point across the set, which removes the
    start-point ambiguity WITHOUT rotating the shape. See :func:`compute_efa_oriented`.
    """
    c = np.asarray(contour, dtype=np.float64)
    if _signed_area(c) < 0:
        c = c[::-1]
    axis, select = _ANCHOR_SELECTORS[anchor]
    return np.roll(c, -int(select(c[:, axis])), axis=0)


def compute_efa_oriented(
    contour: np.ndarray, harmonics: int, anchor: str = "top"
) -> np.ndarray:
    """Orientation-preserving EFA normalization for pre-oriented specimens.

    Removes translation, start-point, and size (the differences that are arbitrary)
    but KEEPS the orientation the user established. This is deliberately NOT the full
    Kuhl & Giardina normalization: pyefd's ``normalize=True`` also removes rotation
    and resolves the resulting 180-degree ambiguity inconsistently, which splits an
    oriented set into spurious "flipped" clusters. Here we standardize the contour
    (:func:`standardize_contour`), take un-rotated coefficients, then divide by the
    first-harmonic size so only shape (at the user's orientation) remains.
    """
    c = standardize_contour(contour, anchor)
    coeffs = compute_efa(c, harmonics=harmonics, normalize=False)
    size = float(np.hypot(coeffs[0, 0], coeffs[0, 2])) or 1.0  # 1st-harmonic scale
    return coeffs / size


def reconstruct_outline(
    coeffs: np.ndarray,
    locus: tuple[float, float] = (0.0, 0.0),
    n_points: int = 300,
) -> np.ndarray:
    """Inverse EFA — reconstruct an outline from coefficients.

    Returns (n_points, 2). `locus` is the DC offset (center). For normalized
    coefficients we leave it at (0, 0) since the position is normalized away.
    """
    if coeffs.ndim != 2 or coeffs.shape[1] != 4:
        raise ValueError(f"coeffs must be (H, 4); got shape {coeffs.shape}")
    return pyefd.reconstruct_contour(coeffs, locus=tuple(locus), num_points=int(n_points))


# ---------- Harmonic power & calibration ----------


def harmonic_power(coeffs: np.ndarray) -> np.ndarray:
    """Per-harmonic power = (a_n^2 + b_n^2 + c_n^2 + d_n^2) / 2.

    Matches Momocs's harm.power(). Returns shape (H,).
    """
    return np.sum(coeffs**2, axis=1) / 2.0


def cumulative_power_fraction(coeffs: np.ndarray) -> np.ndarray:
    """Fraction of total power captured by harmonics 1..n, for each n.

    Returns shape (H,) with values in [0, 1].
    """
    power = harmonic_power(coeffs)
    cumsum = np.cumsum(power)
    total = cumsum[-1]
    if total <= 0:
        return np.zeros_like(cumsum)
    return cumsum / total


def calibrate_harmonics(
    contours: Iterable[np.ndarray],
    max_harmonics: int = 30,
    thresholds: tuple[float, ...] = (0.95, 0.99, 0.999),
) -> dict:
    """Pool cumulative-power curves across many contours; recommend harmonic counts.

    Conceptually matches Momocs's calibrate_harmonicpower_efourier(): fit EFA
    at a generous max_harmonics for each specimen, compute the cumulative
    fraction of power per harmonic, average those curves across specimens,
    and report the smallest harmonic count whose mean cumulative power
    reaches each given threshold.

    Returns:
        {
            "max_harmonics": int,
            "mean_curve":    np.ndarray of shape (max_harmonics,),
            "per_specimen":  np.ndarray of shape (n_specimens, max_harmonics),
            "recommended":   {threshold_float: int_harmonic_count, ...},
            "n_specimens":   int,
        }
    """
    contours_list = list(contours)
    n = len(contours_list)
    if n == 0:
        return {
            "max_harmonics": max_harmonics,
            "mean_curve": np.zeros(max_harmonics),
            "per_specimen": np.zeros((0, max_harmonics)),
            "recommended": {t: max_harmonics for t in thresholds},
            "n_specimens": 0,
        }

    curves = np.zeros((n, max_harmonics))
    for i, c in enumerate(contours_list):
        coeffs = compute_efa(c, harmonics=max_harmonics, normalize=True)
        curves[i] = cumulative_power_fraction(coeffs)

    mean_curve = curves.mean(axis=0)

    recommended = {}
    for threshold in thresholds:
        # smallest n where mean_curve[n-1] >= threshold; clamp to [1, max_harmonics]
        meets = np.where(mean_curve >= threshold)[0]
        recommended[float(threshold)] = int(meets[0] + 1) if len(meets) else max_harmonics

    return {
        "max_harmonics": max_harmonics,
        "mean_curve": mean_curve,
        "per_specimen": curves,
        "recommended": recommended,
        "n_specimens": n,
    }


# ---------- Wide-format DataFrame conversions ----------
#
# CSV output schema: one row per specimen, columns
#   specimen_id_safe, a1, b1, c1, d1, a2, b2, c2, d2, ..., aH, bH, cH, dH


def coefficients_to_dataframe(
    results: dict[str, np.ndarray],
    harmonics: int,
) -> pd.DataFrame:
    """Flatten {specimen_id_safe -> (H, 4) coeffs} into a wide DataFrame."""
    rows = []
    for safe_id, coeffs in results.items():
        if coeffs.shape != (harmonics, 4):
            raise ValueError(
                f"{safe_id}: coeffs shape {coeffs.shape} != expected ({harmonics}, 4)"
            )
        row: dict = {"specimen_id_safe": safe_id}
        flat = coeffs.flatten()  # row-major: a1, b1, c1, d1, a2, b2, ...
        for n in range(harmonics):
            row[f"a{n+1}"] = flat[4 * n + 0]
            row[f"b{n+1}"] = flat[4 * n + 1]
            row[f"c{n+1}"] = flat[4 * n + 2]
            row[f"d{n+1}"] = flat[4 * n + 3]
        rows.append(row)
    return pd.DataFrame(rows)


def dataframe_to_coefficients(df: pd.DataFrame, harmonics: int) -> dict[str, np.ndarray]:
    """Inverse of coefficients_to_dataframe."""
    out: dict[str, np.ndarray] = {}
    for _, row in df.iterrows():
        coeffs = np.zeros((harmonics, 4))
        for n in range(harmonics):
            coeffs[n, 0] = row[f"a{n+1}"]
            coeffs[n, 1] = row[f"b{n+1}"]
            coeffs[n, 2] = row[f"c{n+1}"]
            coeffs[n, 3] = row[f"d{n+1}"]
        out[row["specimen_id_safe"]] = coeffs
    return out


def coefficient_column_names(harmonics: int) -> list[str]:
    """List of coefficient column names in canonical order."""
    cols = []
    for n in range(1, harmonics + 1):
        cols += [f"a{n}", f"b{n}", f"c{n}", f"d{n}"]
    return cols


# ---------- PCA (Stage 7) ----------


def run_pca_on_coefficients(coefficients_df: pd.DataFrame, harmonics: int) -> dict:
    """Fit PCA on the EFA coefficient matrix for one view.

    Per spec Q3: fit with all available components, expose N to the user
    downstream. The number of components actually returned is
    min(n_specimens, n_features), since PCA can't extract more.

    Returns:
        {
            "specimen_ids":           list of specimen_id_safe (row order),
            "scores":                 (n_specimens, n_components),
            "loadings":               (n_components, n_features) — pca.components_,
            "eigenvalues":            (n_components,) — pca.explained_variance_,
            "explained_variance_ratio":      (n_components,),
            "cumulative_variance_ratio":     (n_components,),
            "mean":                   (n_features,) — for back-projection to shape,
            "feature_names":          list of EFA coef names (a1, b1, c1, ...),
            "n_specimens":            int,
            "n_features":             int,
            "n_components":           int (= min(n_specimens, n_features)),
        }
    """
    from sklearn.decomposition import PCA

    feature_names = coefficient_column_names(harmonics)
    missing = [c for c in feature_names if c not in coefficients_df.columns]
    if missing:
        raise ValueError(
            f"coefficient DataFrame missing columns: {missing[:3]}{'...' if len(missing) > 3 else ''}"
        )

    X = coefficients_df[feature_names].to_numpy(dtype=np.float64)
    n_specimens, n_features = X.shape
    if n_specimens < 2:
        raise ValueError(
            f"need at least 2 specimens for PCA; got {n_specimens}"
        )

    n_components = min(n_specimens, n_features)
    pca = PCA(n_components=n_components)
    scores = pca.fit_transform(X)

    return {
        "specimen_ids": coefficients_df["specimen_id_safe"].tolist(),
        "scores": scores,
        "loadings": pca.components_,
        "eigenvalues": pca.explained_variance_,
        "explained_variance_ratio": pca.explained_variance_ratio_,
        "cumulative_variance_ratio": np.cumsum(pca.explained_variance_ratio_),
        "mean": pca.mean_,
        "feature_names": feature_names,
        "n_specimens": int(n_specimens),
        "n_features": int(n_features),
        "n_components": int(n_components),
    }


def pca_scores_dataframe(pca_result: dict) -> pd.DataFrame:
    """Scores as (n_specimens, n_components) DataFrame: specimen_id_safe, PC1, PC2, ..."""
    n = pca_result["n_components"]
    cols = ["specimen_id_safe"] + [f"PC{i+1}" for i in range(n)]
    rows = [
        [sid] + list(score) for sid, score in zip(pca_result["specimen_ids"], pca_result["scores"])
    ]
    return pd.DataFrame(rows, columns=cols)


def pca_loadings_dataframe(pca_result: dict) -> pd.DataFrame:
    """Loadings as (n_features, n_components) DataFrame: feature, PC1, PC2, ...
    plus a leading 'mean' column with the feature mean (needed for back-projection).
    """
    n = pca_result["n_components"]
    cols = ["feature", "mean"] + [f"PC{i+1}" for i in range(n)]
    rows = []
    for i, fname in enumerate(pca_result["feature_names"]):
        # pca.components_ is (n_components, n_features) so we transpose access
        row = [fname, pca_result["mean"][i]] + [pca_result["loadings"][k, i] for k in range(n)]
        rows.append(row)
    return pd.DataFrame(rows, columns=cols)


def pca_eigenvalues_dataframe(pca_result: dict) -> pd.DataFrame:
    """Per-PC eigenvalue + variance fractions: PC, eigenvalue, var_ratio, cum_var_ratio."""
    rows = []
    for i in range(pca_result["n_components"]):
        rows.append(
            {
                "PC": i + 1,
                "eigenvalue": pca_result["eigenvalues"][i],
                "var_ratio": pca_result["explained_variance_ratio"][i],
                "cum_var_ratio": pca_result["cumulative_variance_ratio"][i],
            }
        )
    return pd.DataFrame(rows)


def reconstruct_from_pca(
    pca_result: dict, pc_values: dict[int, float], harmonics: int
) -> np.ndarray:
    """Back-project a hypothetical point in PC space to an outline.

    pc_values: {1: 1.5, 2: -0.3, ...} — PC scores in 1-indexed natural form.
    Returns: an outline (n_points, 2) suitable for plotting.

    Used by Stage 8 morphospace shape-reconstructions-at-grid-points.
    """
    n_features = pca_result["n_features"]
    coeffs_flat = pca_result["mean"].copy()
    for pc_idx, value in pc_values.items():
        if pc_idx < 1 or pc_idx > pca_result["n_components"]:
            continue
        coeffs_flat += value * pca_result["loadings"][pc_idx - 1, :]
    coeffs = coeffs_flat.reshape(harmonics, 4)
    return reconstruct_outline(coeffs, locus=(0.0, 0.0), n_points=400)
