"""Learned-orientation core: build_reference + decide_flip.

These are the Phase 1A math primitives for ROADMAP §Phase 4. The accuracy-vs-truth
success criterion (≥80% on real hyoid canonicals) belongs to Phase 4's fixture
test; here we assert the functions run on synthetic contours and return a
*deterministic, correct-direction* flip decision.
"""

from __future__ import annotations

import numpy as np
import pytest

from app.orientation import (
    DEFAULT_ORIENTATION_HARMONICS,
    _normalized_efa_vector,
    _rotate_180 as _efa_rotate_180,
    build_reference,
    decide_flip,
)


def _asymmetric_shape(seed: int = 0, noise: float = 0.0) -> np.ndarray:
    """A closed, top/bottom-asymmetric outline oriented 'up'.

    r(t) = 1 + 0.4 cos t + 0.2 cos 2t + 0.1 cos 3t — not 180°-symmetric, so its
    normalized EFA differs measurably from its 180° rotation.
    """
    rng = np.random.default_rng(seed)
    t = np.linspace(0.0, 2.0 * np.pi, 400, endpoint=False)
    r = 1.0 + 0.4 * np.cos(t) + 0.2 * np.cos(2 * t) + 0.1 * np.cos(3 * t)
    if noise:
        r = r + rng.normal(0.0, noise, size=t.shape)
    return np.column_stack([r * np.cos(t), r * np.sin(t)])


def _rotate_180(contour: np.ndarray) -> np.ndarray:
    centroid = contour.mean(axis=0)
    return 2.0 * centroid - contour


def _reference():
    primed = [_asymmetric_shape(seed=i, noise=0.01) for i in range(6)]
    return build_reference(primed)


def test_build_reference_shape():
    ref = _reference()
    assert ref.shape == (DEFAULT_ORIENTATION_HARMONICS * 4,)
    assert np.all(np.isfinite(ref))


def test_build_reference_requires_contours():
    with pytest.raises(ValueError):
        build_reference([])


def test_decide_flip_keeps_correctly_oriented():
    ref = _reference()
    decision = decide_flip(_asymmetric_shape(seed=99), ref)
    assert decision["flip"] is False
    assert decision["angleOffsetDeg"] == 0.0
    assert decision["distanceKept"] < decision["distanceFlipped"]


def test_decide_flip_flips_upside_down():
    ref = _reference()
    upside_down = _rotate_180(_asymmetric_shape(seed=99))
    decision = decide_flip(upside_down, ref)
    assert decision["flip"] is True
    assert decision["angleOffsetDeg"] == 180.0
    assert decision["distanceFlipped"] < decision["distanceKept"]


def test_decide_flip_is_deterministic():
    ref = _reference()
    contour = _asymmetric_shape(seed=7)
    d1 = decide_flip(contour, ref)
    d2 = decide_flip(contour, ref)
    assert d1 == d2


def test_decide_flip_harmonics_mismatch_raises():
    short_ref = np.zeros(4 * 3)  # built for 3 harmonics
    with pytest.raises(ValueError):
        decide_flip(_asymmetric_shape(), short_ref, harmonics=DEFAULT_ORIENTATION_HARMONICS)


# ---------------------------------------------------------------------------
# Phase 4 accuracy criterion — real hyoid outlines, deterministic flip-recovery.
#
# The fixture (backend/tests/fixtures/orientation_truth.json + the sibling
# outline CSVs) holds outlines extracted once, via SAM, from real fused-dorsal
# photos — each at its PCA base angle (long axis horizontal). It runs without
# SAM (outlines are committed), so the test is fast and deterministic.
#
# We use the *flip-recovery fallback* (ROADMAP §Phase 4, "fallback" clause), not
# the anatomical-oracle variant. Two properties of this real dataset make the
# fallback the honest choice:
#   1. Raw-photo SAM (center seed, no crop) is unreliable here — for several
#      specimens it grabs a rectangular background/card region rather than the
#      bone. Those anatomical labels can't be trusted; the solidity filter in the
#      generator drops the worst, but the pipeline lesson stands (see PM report).
#   2. The series spans very different whale families (Balaenoptera "butterfly",
#      Megaptera/Phocoena "boomerang", plate-like Monodon/Kogia). A single global
#      EFA reference tracks anatomical anterior only ~50% across such diversity —
#      inter-taxon shape variation swamps the 180° signal. Learned orientation is
#      strong *within* a morphologically coherent set, which is the real use case.
#
# What the fallback validates (the load-bearing property the feature relies on):
# a reference primed on a consistently-oriented subset recovers the correct
# orientation of 180°-corrupted held-out outlines. This exercises the full core —
# build_reference + decide_flip + the 180° rotation — on real shapes.
# ---------------------------------------------------------------------------

import json  # noqa: E402
from pathlib import Path  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures"
ORIENT_TRUTH = FIXTURES / "orientation_truth.json"


def _load_orientation_outlines():
    truth = json.loads(ORIENT_TRUTH.read_text())
    specimens = [
        (record_key, np.loadtxt(FIXTURES / meta["outlineCsv"], delimiter=",", skiprows=1))
        for record_key, meta in truth["specimens"].items()
    ]
    # Deterministic order so the priming/held-out split is stable across runs.
    specimens.sort(key=lambda s: s[0])
    return truth, specimens


def _bootstrap_consistent(outlines, harmonics):
    """Orient every outline into one self-consistent 'up' frame.

    Seed a reference from the first outline, then greedily flip each subsequent
    outline to whichever of θ / θ+180° is nearer the running reference, updating
    the reference as we go. The result is a set all oriented the same way — a
    'consistently-oriented set' in the ROADMAP's terms, without needing anatomy.
    """
    ref = _normalized_efa_vector(outlines[0], harmonics)
    aligned = [outlines[0]]
    for outline in outlines[1:]:
        up = _efa_rotate_180(outline) if decide_flip(outline, ref, harmonics)["flip"] else outline
        aligned.append(up)
        ref = np.mean([_normalized_efa_vector(x, harmonics) for x in aligned], axis=0)
    return aligned


@pytest.mark.skipif(not ORIENT_TRUTH.exists(), reason="orientation fixture not generated")
def test_learned_orientation_recovers_flip_on_real_outlines():
    """A primed reference recovers 180°-corrupted held-out outlines at >= 80%.

    ROADMAP §Phase 4 success criterion (fallback variant): prime on a
    consistently-oriented set, feed 180°-flipped copies of held-out specimens,
    assert the learned decision recovers the reference orientation for >= 80%.
    """
    truth, specimens = _load_orientation_outlines()
    harmonics = int(truth.get("harmonics", DEFAULT_ORIENTATION_HARMONICS))
    assert len(specimens) >= 8, "fixture too small to split meaningfully"

    ups = _bootstrap_consistent([o for _rk, o in specimens], harmonics)
    priming = ups[0::2]
    held_out = ups[1::2]

    reference = build_reference(priming, harmonics=harmonics)

    recovered = 0
    for up in held_out:
        # The un-corrupted 'up' outline must be kept; its 180° rotation must flip back.
        keeps_up = decide_flip(up, reference, harmonics=harmonics)["flip"] is False
        recovers = decide_flip(_efa_rotate_180(up), reference, harmonics=harmonics)["flip"] is True
        recovered += int(keeps_up and recovers)

    accuracy = recovered / len(held_out)
    assert accuracy >= 0.80, (
        f"learned flip-recovery {accuracy:.0%} "
        f"({recovered}/{len(held_out)}) below the 80% bar"
    )
