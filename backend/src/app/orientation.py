"""Learned-orientation core (ROADMAP §Phase 4).

Replaces the hyoid app's hardcoded anterior-up anatomy heuristic
(``processing.anterior_is_up``) with a data-driven signature:

- The user hand-orients a handful of *priming* specimens so they look "up".
- ``build_reference`` averages the normalized EFA-8 coefficient vectors of those
  oriented outlines into a single reference signature.
- For every remaining specimen, the base angle θ (mask long-axis horizontal) is
  ambiguous by 180°. ``decide_flip`` compares the outline at θ vs θ+180° and
  picks whichever normalized EFA-8 vector is nearer the reference.

Why this works with *normalized* EFA: Kuhl & Giardina normalization removes
scale, translation, and starting phase, and aligns the first-harmonic axis — but
pyefd does **not** fully collapse the 180° rotational ambiguity, so a shape and
its 180° rotation land at measurably different normalized coefficients (verified
empirically). That residual is exactly the signal a top/bottom decision needs.

Pure functions only — no state I/O, no UI. The EFA computation is delegated to
the ported ``analysis.compute_efa`` so the signature stays in parity with the
rest of the pipeline.
"""

from __future__ import annotations

import numpy as np

from .analysis import compute_efa

DEFAULT_ORIENTATION_HARMONICS = 8


def _normalized_efa_vector(contour: np.ndarray, harmonics: int) -> np.ndarray:
    """Normalized EFA coefficients for one outline, flattened row-major (a1,b1,c1,d1,a2,…).

    Uses ``normalize=True`` so the signature is comparable across specimens
    regardless of size/position/rotation-phase — while retaining the residual
    that distinguishes a 180° flip.
    """
    coeffs = compute_efa(np.asarray(contour, dtype=np.float64), harmonics=harmonics, normalize=True)
    return coeffs.flatten()


def _rotate_180(contour: np.ndarray) -> np.ndarray:
    """Rotate a contour 180° about its centroid (point reflection)."""
    pts = np.asarray(contour, dtype=np.float64)
    centroid = pts.mean(axis=0)
    return 2.0 * centroid - pts


def build_reference(
    oriented_contours: list[np.ndarray],
    harmonics: int = DEFAULT_ORIENTATION_HARMONICS,
) -> np.ndarray:
    """Mean of normalized EFA-``harmonics`` coefficient vectors over the priming set.

    Args:
        oriented_contours: outlines already rotated to the user's "up" orientation.
        harmonics: harmonic order for the signature (default 8, per ROADMAP §Phase 4).

    Returns:
        The reference coefficient vector, shape ``(harmonics * 4,)``. Flatten it to
        a list for the ``LearnedReference.referenceCoeffs`` field.

    Raises:
        ValueError: if no priming contours are supplied.
    """
    contours = list(oriented_contours)
    if not contours:
        raise ValueError("build_reference needs at least one oriented contour.")
    vectors = np.stack([_normalized_efa_vector(c, harmonics) for c in contours], axis=0)
    return vectors.mean(axis=0)


def decide_flip(
    contour: np.ndarray,
    reference: np.ndarray,
    harmonics: int = DEFAULT_ORIENTATION_HARMONICS,
) -> dict:
    """Decide whether an outline should be flipped 180° to match the learned "up".

    Compares the outline as-given (θ) against its 180° rotation (θ+180°) and picks
    whichever normalized EFA-``harmonics`` vector is closer (Euclidean) to the
    reference signature.

    Args:
        contour: outline at the base angle θ (long axis already horizontal).
        reference: reference vector from :func:`build_reference`.
        harmonics: must match the harmonics used to build the reference.

    Returns:
        A dict describing the deterministic decision::

            {
              "flip": bool,              # True → apply the 180° flip
              "angleOffsetDeg": 0.0|180.0,
              "distanceKept": float,     # ‖EFA(θ)      − reference‖
              "distanceFlipped": float,  # ‖EFA(θ+180°) − reference‖
            }
    """
    reference = np.asarray(reference, dtype=np.float64).ravel()
    kept_vec = _normalized_efa_vector(contour, harmonics)
    flipped_vec = _normalized_efa_vector(_rotate_180(contour), harmonics)

    if reference.shape != kept_vec.shape:
        raise ValueError(
            f"reference length {reference.shape[0]} does not match harmonics={harmonics} "
            f"(expected {kept_vec.shape[0]}). Rebuild the reference at the same harmonics."
        )

    distance_kept = float(np.linalg.norm(kept_vec - reference))
    distance_flipped = float(np.linalg.norm(flipped_vec - reference))
    flip = distance_flipped < distance_kept

    return {
        "flip": bool(flip),
        "angleOffsetDeg": 180.0 if flip else 0.0,
        "distanceKept": distance_kept,
        "distanceFlipped": distance_flipped,
    }
